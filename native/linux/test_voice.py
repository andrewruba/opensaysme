"""Audio timing checks without an X11 connection or microphone."""

import base64
from datetime import datetime
import json
import unittest
from unittest.mock import Mock, patch

from voice import AudioSampleClock, Voice


def timestamp(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


class AudioTimingTests(unittest.TestCase):
    def test_late_reads_do_not_shift_the_sample_clock(self):
        clock = AudioSampleClock(10.0, 1000.0)
        first = clock.stamp(480, 10.1)
        second = clock.stamp(2400, 12.0)
        third = clock.stamp(480, 12.01)
        self.assertEqual([first["startSample"], second["startSample"], third["startSample"]], [0, 480, 2880])
        self.assertAlmostEqual(timestamp(first["capturedAt"]), 1000.08, places=6)
        self.assertAlmostEqual(timestamp(second["capturedAt"]), 1000.10, places=6)
        self.assertAlmostEqual(timestamp(third["capturedAt"]), 1000.20, places=6)
        self.assertEqual(first["timing"], "estimated")

    def test_origin_never_precedes_start_and_empty_audio_is_rejected(self):
        clock = AudioSampleClock(10.0, 1000.0)
        self.assertEqual(timestamp(clock.stamp(2400, 10.02)["capturedAt"]), 1000.0)
        with self.assertRaises(ValueError):
            clock.stamp(0, 10.02)
        self.assertEqual(clock.samples, 2400)

    def voice(self):
        desktop = Mock()
        recorder = Mock()
        recorder.poll.return_value = 0
        recorder.stdout.fileno.return_value = 101
        voice = Voice(desktop)
        with patch("voice.subprocess.Popen", return_value=recorder), patch("voice.os.set_blocking"), \
                patch("voice.time.monotonic", return_value=10.0), patch("voice.time.time", return_value=1000.0):
            voice.start("first")
        return voice, recorder

    def events(self, voice):
        return [json.loads(line) for line in voice.output]

    def test_partial_samples_keep_offsets_through_stop_drain(self):
        voice, recorder = self.voice()
        with patch("voice.os.read", side_effect=[bytes(961), bytes(959), b""]), \
                patch("voice.time.monotonic", side_effect=[10.1, 10.15, 10.20, 10.25]):
            voice.read_audio()
            self.assertEqual(len(voice.audio_tail), 1)
            voice.command({"type": "stop", "turnId": "first"})
            voice.read_audio()
            voice.read_audio()
        events = self.events(voice)
        self.assertEqual([event["type"] for event in events], ["audio-started", "audio", "audio", "audio-stopped"])
        audio = [event for event in events if event["type"] == "audio"]
        self.assertEqual([event["startSample"] for event in audio], [0, 480])
        self.assertEqual([len(base64.b64decode(event["data"])) for event in audio], [960, 960])
        self.assertAlmostEqual(timestamp(audio[1]["capturedAt"]) - timestamp(audio[0]["capturedAt"]), 0.02, places=6)
        self.assertIsNone(voice.audio_clock)
        self.assertEqual(voice.audio_tail, b"")
        recorder.terminate.assert_called_once()
        recorder.stdout.close.assert_called_once()

    def test_cancel_discards_partial_sample_and_new_turn_resets_clock(self):
        voice, recorder = self.voice()
        with patch("voice.os.read", return_value=bytes(961)), patch("voice.time.monotonic", return_value=10.1):
            voice.read_audio()
        voice.command({"type": "cancel", "turnId": "first"})
        self.assertIsNone(voice.audio_clock)
        self.assertEqual(voice.audio_tail, b"")
        with patch("voice.subprocess.Popen", return_value=recorder), patch("voice.os.set_blocking"), \
                patch("voice.time.monotonic", return_value=20.0), patch("voice.time.time", return_value=2000.0):
            voice.start("second")
        with patch("voice.os.read", return_value=bytes(960)), patch("voice.time.monotonic", return_value=20.1):
            voice.read_audio()
        audio = [event for event in self.events(voice) if event["type"] == "audio"]
        self.assertEqual([event["startSample"] for event in audio], [0, 0])
        self.assertEqual([event["turnId"] for event in audio], ["first", "second"])
        self.assertAlmostEqual(timestamp(audio[1]["capturedAt"]), 2000.08, places=6)


if __name__ == "__main__":
    unittest.main()
