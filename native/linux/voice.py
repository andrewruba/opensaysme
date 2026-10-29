#!/usr/bin/env python3
"""Persistent X11 activation and in-memory 24 kHz mono S16LE microphone stream."""

import argparse
import base64
import collections
from datetime import datetime, timezone
import json
import os
import re
import select
import signal
import subprocess
import sys
import time
from x11 import Desktop


class AudioSampleClock:
    """Estimate an audio origin once, then advance by emitted PCM samples.

    arecord's raw pipe has no device timestamps. The first read minus its PCM
    duration estimates capture start; device/pipe buffering can still shift it.
    Later pipe/IPC delays and wall-clock changes must not move that origin.
    """

    def __init__(self, started_at, wall_at_start):
        self.started_at = started_at
        self.wall_at_start = wall_at_start
        self.origin = None
        self.samples = 0

    def stamp(self, count, read_at):
        if count <= 0:
            raise ValueError("Empty audio interval")
        if self.origin is None:
            self.origin = max(self.started_at, read_at - count / 24000)
        captured = self.wall_at_start + self.origin - self.started_at + self.samples / 24000
        fields = {
            "capturedAt": datetime.fromtimestamp(captured, timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z"),
            "startSample": self.samples,
            "timing": "estimated",
        }
        self.samples += count
        return fields


class Voice:
    def __init__(self, desktop):
        self.desktop = desktop
        self.turn = None
        self.recorder = None
        self.started = False
        self.stopping_at = None
        self.capture_at = None
        self.audio_tail = b""
        self.audio_clock = None
        self.commands = b""
        self.output = collections.deque()
        self.output_bytes = 0
        self.running = True
        self.pointer_at = 0
        self.last_pointer = None

    def emit(self, kind, **fields):
        line = (json.dumps({"type": kind, **fields}, separators=(",", ":")) + "\n").encode()
        if self.output_bytes + len(line) > 512 * 1024:
            raise OSError("Consumer stopped reading")
        self.output.append(line)
        self.output_bytes += len(line)

    def flush(self):
        if self.output:
            sent = os.write(sys.stdout.fileno(), self.output[0])
            self.output_bytes -= sent
            if sent == len(self.output[0]):
                self.output.popleft()
            else:
                self.output[0] = self.output[0][sent:]

    def end_recorder(self):
        if self.recorder:
            recorder, self.recorder = self.recorder, None
            if recorder.poll() is None:
                recorder.terminate()
                try:
                    recorder.wait(timeout=0.5)
                except subprocess.TimeoutExpired:
                    recorder.kill()
                    recorder.wait(timeout=0.5)
            recorder.stdout.close()
        self.audio_tail = b""
        self.audio_clock = None
        self.stopping_at = None

    def cancel(self):
        self.end_recorder()
        self.desktop.ungrab(self.desktop.escape)
        self.turn = None
        self.started = False

    def fail(self, code):
        turn = self.turn
        self.cancel()
        self.emit("error", **({"turnId": turn} if turn else {}), code=code)

    def start(self, turn):
        if self.turn:
            self.emit("error", turnId=turn, code="invalid-command")
            return
        self.turn = turn
        try:
            self.desktop.grab(self.desktop.escape, 0)
        except OSError:
            self.fail("hotkey-unavailable")
            return
        try:
            self.recorder = subprocess.Popen([
                "arecord", "--quiet", "--device", "default", "--file-type", "raw",
                "--format", "S16_LE", "--rate", "24000", "--channels", "1",
                "--period-time", "20000", "--buffer-time", "100000", "--fatal-errors",
            ], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            os.set_blocking(self.recorder.stdout.fileno(), False)
        except OSError:
            self.fail("microphone-unavailable")
            return
        self.capture_at = time.monotonic()
        self.audio_clock = AudioSampleClock(self.capture_at, time.time())
        self.started = False
        self.pointer_at = 0
        self.last_pointer = None

    def sample_pointer(self):
        if not self.recorder or self.stopping_at is not None:
            return
        now = time.monotonic()
        if now - self.pointer_at < 0.05:
            return
        self.pointer_at = now
        captured_at = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        point = self.desktop.pointer_position()
        if point is not None and point != self.last_pointer:
            self.last_pointer = point
            self.emit("pointer", turnId=self.turn, capturedAt=captured_at,
                      x=point[0], y=point[1], displayId="x11:root")

    def command(self, value):
        if not isinstance(value, dict):
            raise ValueError("Invalid command")
        kind = value.get("type")
        if kind == "shutdown" and set(value) == {"type"}:
            self.running = False
            return
        if set(value) != {"type", "turnId"} or kind not in ("start", "stop", "cancel", "settled"):
            raise ValueError("Invalid command")
        turn = value["turnId"]
        if not isinstance(turn, str) or not re.fullmatch(r"[a-zA-Z0-9-]{1,64}", turn):
            raise ValueError("Invalid turn")
        if kind == "start":
            self.start(turn)
        elif kind == "cancel":
            if self.turn and turn != self.turn:
                return
            if turn == self.turn:
                self.cancel()
            self.emit("audio-stopped", turnId=turn)
        elif turn == self.turn:
            if kind == "settled":
                self.cancel()
            elif self.recorder and self.stopping_at is None:
                self.stopping_at = time.monotonic()
                self.recorder.terminate()
            elif not self.recorder:
                self.emit("audio-stopped", turnId=turn)
        # Late cleanup for a cancelled/failed turn is deliberately idempotent.

    def read_commands(self):
        chunk = os.read(sys.stdin.fileno(), 4096)
        if not chunk:
            self.running = False
            return
        self.commands += chunk
        if len(self.commands) > 8192:
            raise ValueError("Command buffer exceeded")
        while b"\n" in self.commands:
            line, self.commands = self.commands.split(b"\n", 1)
            self.command(json.loads(line))

    def read_audio(self):
        chunk = os.read(self.recorder.stdout.fileno(), 4800)
        read_at = time.monotonic()
        if chunk:
            chunk = self.audio_tail + chunk
            self.audio_tail = chunk[len(chunk) - len(chunk) % 2:] if len(chunk) % 2 else b""
            chunk = chunk[:len(chunk) - len(chunk) % 2]
            if chunk:
                if not self.started:
                    self.started = True
                    self.emit("audio-started", turnId=self.turn)
                    self.desktop.bell()
                self.emit("audio", turnId=self.turn, data=base64.b64encode(chunk).decode("ascii"),
                          **self.audio_clock.stamp(len(chunk) // 2, read_at))
        elif self.stopping_at is not None:
            turn = self.turn
            self.end_recorder()
            self.emit("audio-stopped", turnId=turn)
        else:
            self.fail("capture-failed" if self.started else "microphone-unavailable")

    def run(self):
        try:
            self.desktop.grab(self.desktop.space, 5)
        except OSError:
            self.emit("error", code="hotkey-unavailable")
            while self.output:
                self.flush()
            return
        os.set_blocking(sys.stdin.fileno(), False)
        os.set_blocking(sys.stdout.fileno(), False)
        self.emit("ready")
        while self.running:
            for event in self.desktop.events():
                if event == "cancel" and self.turn:
                    self.emit("cancel")
                    self.end_recorder()
                    self.desktop.ungrab(self.desktop.escape)
                elif event == "toggle":
                    self.emit("toggle")
            readers = [sys.stdin.fileno(), self.desktop.fd]
            audio_fd = self.recorder.stdout.fileno() if self.recorder else None
            if audio_fd is not None:
                readers.append(audio_fd)
            readable, writable, _ = select.select(readers, [sys.stdout.fileno()] if self.output else [], [], 0.05)
            # Cancellation commands take priority over queued audio.
            if sys.stdin.fileno() in readable:
                self.read_commands()
            if self.running and self.recorder and self.recorder.stdout.fileno() == audio_fd and audio_fd in readable:
                self.read_audio()
            if writable:
                self.flush()
            if self.recorder:
                self.sample_pointer()
                now = time.monotonic()
                if self.stopping_at is not None and now - self.stopping_at > 1:
                    self.fail("capture-failed")
                elif self.stopping_at is None and now - self.capture_at > (120 if self.started else 5):
                    self.fail("capture-failed" if self.started else "microphone-unavailable")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pointer", action="store_true")
    args = parser.parse_args()
    desktop = None
    voice = None
    try:
        desktop = Desktop()
        if args.pointer:
            print(json.dumps(desktop.pointer()))
            return
        voice = Voice(desktop)

        def stop(_signum, _frame):
            voice.running = False

        for sig in (signal.SIGINT, signal.SIGTERM):
            signal.signal(sig, stop)
        voice.run()
    except (OSError, AttributeError, ValueError, subprocess.SubprocessError) as error:
        if args.pointer:
            sys.exit(1)
        # Fixed codes only: never echo child output or malformed commands.
        try:
            if voice:
                voice.fail("invalid-command" if isinstance(error, ValueError) else "internal-error")
                deadline = time.monotonic() + 0.2
                while voice.output and time.monotonic() < deadline:
                    if select.select([], [sys.stdout.fileno()], [], 0.02)[1]:
                        voice.flush()
            else:
                print('{"type":"error","code":"hotkey-unavailable"}', flush=True)
        except (OSError, subprocess.SubprocessError):
            pass
    finally:
        if voice:
            voice.end_recorder()
        if desktop:
            desktop.close()


if __name__ == "__main__":
    main()
