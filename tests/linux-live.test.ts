import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { captureLinuxContext, captureLinuxFrame, focusLinux, inspectLinux, linuxVoiceHelper, probeLinux, testLinuxHotkey } from '../src/desktop/platforms/linux.js';
import { runCommand } from '../src/desktop/process.js';
import { nativeVoiceEventSchema, type NativeVoiceCommand, type NativeVoiceEvent } from '../src/desktop/voice-types.js';

// Run only in an explicitly opted-in virtual display, never the user's desktop.
const enabled = process.env.OPENSAYSME_X11_TEST === '1' && process.platform === 'linux';
describe.skipIf(!enabled)('Linux X11 virtual desktop integration', () => {
  const fixtures: ChildProcess[] = [];
  const fixtureMessages: string[] = [];
  const titles = ['OpenSaysMe fixture one', 'OpenSaysMe fixture two'];
  let firstWindow: string;
  let secondWindow: string;
  let fixtureDirectory: string;

  async function launch(file: string, args: string[], input?: string): Promise<void> {
    const child = spawn(file, args, { stdio: file === 'openbox'
      ? 'inherit'
      : [input === undefined ? 'ignore' : 'pipe', 'ignore', 'pipe'] });
    fixtures.push(child);
    child.stderr?.on('data', (chunk: Buffer) => fixtureMessages.push(`${file}: ${chunk.toString('utf8')}`));
    await once(child, 'spawn');
    if (input !== undefined) child.stdin!.end(input);
  }

  async function eventually(read: () => Promise<string>, matches: (value: string) => boolean): Promise<string> {
    const deadline = Date.now() + 15_000;
    let diagnostic = 'No response';
    while (Date.now() < deadline) {
      try {
        const result = await read();
        if (matches(result)) return result.trim();
        diagnostic = JSON.stringify(result);
      } catch (error) {
        diagnostic = error instanceof Error ? error.message : 'Fixture not ready';
      }
      await sleep(50);
    }
    const tree = await runCommand('xwininfo', ['-root', '-tree']).catch(() => 'No window tree');
    throw new Error(`Virtual desktop fixture did not become ready within fifteen seconds: ${diagnostic}\n${fixtureMessages.join('')}\n${JSON.stringify(fixtures.map((child) => ({ pid: child.pid, exit: child.exitCode, signal: child.signalCode })))}\n${tree}`);
  }

  beforeAll(async () => {
    if (!process.env.DISPLAY || process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE !== 'x11') {
      throw new Error('Run with xvfb-run and XDG_SESSION_TYPE=x11. Native Wayland is not covered.');
    }
    for (const [index, title] of titles.entries()) {
      await launch('xmessage', ['-title', title, '-geometry', `300x100+${index * 350}+40`, 'Synthetic agent window']);
    }
    const ids = await Promise.all(titles.map((title) => eventually(
      () => runCommand('xdotool', ['search', '--name', `^${title}$`]),
      (value) => /^[1-9]\d*\s*$/.test(value),
    )));
    [firstWindow, secondWindow] = ids as [string, string];
    await launch('openbox', ['--sm-disable']);
    await eventually(
      async () => { await focusLinux(firstWindow); return firstWindow; },
      (value) => value === firstWindow,
    );
    fixtureDirectory = await mkdtemp(join(tmpdir(), 'opensaysme-x11-'));
    // Fake only the microphone process. Real Xlib, grabs, pipes, commands, and
    // cancellation run against Xvfb without host devices or provider requests.
    await writeFile(join(fixtureDirectory, 'arecord'), `#!/usr/bin/env python3
import os, signal, sys, time
from pathlib import Path
if '--version' in sys.argv:
    print('Synthetic arecord fixture')
    sys.exit(0)
expected = ['--quiet', '--device', 'default', '--file-type', 'raw', '--format', 'S16_LE', '--rate', '24000', '--channels', '1', '--period-time', '20000', '--buffer-time', '100000', '--fatal-errors']
if sys.argv[1:] != expected:
    sys.exit(2)
directory = Path(os.environ['OPENSAYSME_RECORDER_FIXTURE'])
if (directory / 'fail').exists():
    sys.exit(1)
(directory / 'pid').write_text(str(os.getpid()))
signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
while True:
    sys.stdout.buffer.write(bytes(960))
    sys.stdout.buffer.flush()
    time.sleep(0.02)
`, { mode: 0o700 });
  }, 40_000);

  afterAll(async () => {
    await Promise.all(fixtures.reverse().map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      const forceKill = setTimeout(() => child.kill('SIGKILL'), 500);
      try { await exited; } finally { clearTimeout(forceKill); }
    }));
    if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true });
  });

  it('probes and inspects a real X11 window using distro-provided tools', async () => {
    const report = await probeLinux();
    expect(report.session).toBe('x11');
    expect(report.capabilities.activeWindow.status).toBe('available');
    expect(report.capabilities.globalHotkey.status).toBe('unverified');
    const snapshot = await inspectLinux(false);
    expect(snapshot.window).toEqual({ id: firstWindow, title: titles[0], application: 'Xmessage' });
    expect(snapshot.selectedText).toBeUndefined();
  });

  it('checks audio sample timing without capture devices', async () => {
    await runCommand('python3', ['native/linux/test_voice.py']);
  });

  it('focuses the exact second window and restores the first', async () => {
    await focusLinux(secondWindow);
    expect((await inspectLinux(false)).window?.id).toBe(secondWindow);
    await focusLinux(firstWindow);
    expect((await inspectLinux(false)).window?.id).toBe(firstWindow);
  });

  it('reads an explicit PRIMARY selection and preserves whitespace', async () => {
    const selection = '  Synthetic selected context\nwith a trailing newline\n';
    await launch('xsel', ['--primary', '--input', '--nodetach'], selection);
    await eventually(
      () => runCommand('xsel', ['--primary', '--output', '--selectionTimeout', '500']),
      (value) => value === selection,
    );
    expect((await inspectLinux(true)).selectedText).toBe(selection);
  });

  it('observes the registered shortcut and releases its grab afterwards', async () => {
    let completed = false;
    const pending = testLinuxHotkey(5).finally(() => { completed = true; });
    // Inject only inside Xvfb. Repetition avoids a startup race with Python/Xlib.
    for (let attempt = 0; attempt < 15 && !completed; attempt += 1) {
      await sleep(100);
      if (!completed) await runCommand('xdotool', ['key', '--clearmodifiers', 'ctrl+shift+space']);
    }
    expect((await pending).status).toBe('passed');
    // A subsequent registration must succeed and expire, rather than conflict.
    expect((await testLinuxHotkey(1)).status).toBe('not-observed');
  }, 10_000);

  it('captures the pointer owning window independently from the active window', async () => {
    await focusLinux(firstWindow);
    await runCommand('xdotool', ['mousemove', '--window', secondWindow, '60', '60']);
    const context = await captureLinuxContext();
    expect(context.activeWindow?.id).toBe(firstWindow);
    expect(context.pointer?.window).toEqual({ id: secondWindow, title: titles[1], application: 'Xmessage' });
    expect(context.pointer?.x).toBeGreaterThan(300);
    expect(context.selectedText).toContain('Synthetic selected context');
    expect(context.warnings).toEqual([expect.stringContaining('X11 PRIMARY')]);
    expect((await inspectLinux(false)).window?.id).toBe(firstWindow);
  });

  async function voiceFixture() {
    const spec = await linuxVoiceHelper();
    const child = spawn(spec.file, spec.args, { stdio: ['pipe', 'pipe', 'pipe'], env: {
      ...process.env, PATH: `${fixtureDirectory}:${process.env.PATH}`, OPENSAYSME_RECORDER_FIXTURE: fixtureDirectory,
    } });
    fixtures.push(child);
    const events: NativeVoiceEvent[] = [];
    let buffer = '';
    let failure: Error | undefined;
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      while (buffer.includes('\n')) {
        const end = buffer.indexOf('\n');
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try { events.push(nativeVoiceEventSchema.parse(JSON.parse(line))); }
        catch { failure = new Error('Invalid native voice fixture event'); }
      }
    });
    child.stderr.on('data', (chunk: Buffer) => { fixtureMessages.push(chunk.toString('utf8')); });
    const exited = once(child, 'exit');
    const take = async (type: NativeVoiceEvent['type'], turnId?: string): Promise<NativeVoiceEvent> => {
      await eventually(async () => {
        if (failure) throw failure;
        const index = events.findIndex((event) => event.type === type && (!turnId || 'turnId' in event && event.turnId === turnId));
        return index < 0 ? '' : String(index + 1);
      }, (value) => value !== '');
      const index = events.findIndex((event) => event.type === type && (!turnId || 'turnId' in event && event.turnId === turnId));
      return events.splice(index, 1)[0]!;
    };
    const send = (command: NativeVoiceCommand) => child.stdin.write(`${JSON.stringify(command)}\n`);
    await take('ready');
    return { child, events, exited, send, take };
  }

  async function assertRecorderStopped(): Promise<void> {
    const pid = Number(await readFile(join(fixtureDirectory, 'pid'), 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
  }

  it('captures bounded JPEG frames in virtual-root coordinates without changing focus', async () => {
    await focusLinux(firstWindow);
    const frame = await captureLinuxFrame();
    expect(frame.display.id).toBe('x11:root');
    expect(frame.display.bounds.x).toBe(0);
    expect(frame.display.bounds.y).toBe(0);
    expect(frame.image.width).toBeLessThanOrEqual(1600);
    expect(frame.image.height).toBeLessThanOrEqual(1600);
    const bytes = Buffer.from(frame.image.data, 'base64');
    expect(bytes.subarray(0, 2)).toEqual(Buffer.from([255, 216]));
    expect(bytes.length).toBeLessThanOrEqual(700000);
    expect((await inspectLinux(false)).window?.id).toBe(firstWindow);
  });

  it('tracks pointer trajectories only during recording and keeps display identity consistent', async () => {
    const helper = await voiceFixture();
    await runCommand('xdotool', ['mousemove', '25', '30']);
    await sleep(150);
    expect(helper.events.some((event) => event.type === 'pointer')).toBe(false);
    helper.send({ type: 'start', turnId: 'attention' });
    await helper.take('audio-started', 'attention');
    expect(await helper.take('pointer', 'attention')).toMatchObject({ x: 25, y: 30, displayId: 'x11:root' });
    for (const [x, y] of [[120, 50], [150, 80], [120, 100]]) {
      await runCommand('xdotool', ['mousemove', String(x), String(y)]);
      const point = await helper.take('pointer', 'attention');
      expect(point).toMatchObject({ x, y, displayId: 'x11:root' });
      if (point.type === 'pointer') expect(Number.isNaN(Date.parse(point.capturedAt))).toBe(false);
    }
    helper.send({ type: 'stop', turnId: 'attention' });
    await helper.take('audio-stopped', 'attention');
    helper.events.splice(0);
    await runCommand('xdotool', ['mousemove', '200', '200']);
    await sleep(200);
    expect(helper.events.some((event) => event.type === 'pointer')).toBe(false);
    helper.send({ type: 'settled', turnId: 'attention' });
    helper.send({ type: 'shutdown' });
    await helper.exited;
  }, 15_000);

  it('streams PCM, suppresses held-hotkey repeats, and retains Escape until transcription settles', async () => {
    const helper = await voiceFixture();
    await runCommand('xdotool', ['keydown', 'ctrl+shift+space']);
    await helper.take('toggle');
    await sleep(900);
    expect(helper.events.filter((event) => event.type === 'toggle')).toHaveLength(0);
    await runCommand('xdotool', ['keyup', 'ctrl+shift+space']);
    helper.send({ type: 'start', turnId: 'first' });
    await helper.take('audio-started', 'first');
    const audio = await helper.take('audio', 'first');
    expect(audio.type).toBe('audio');
    if (audio.type === 'audio') {
      const pcm = Buffer.from(audio.data, 'base64');
      expect(pcm.length).toBeGreaterThan(0);
      expect(pcm.length % 2).toBe(0);
      expect(pcm.equals(Buffer.alloc(pcm.length))).toBe(true);
      expect(audio.startSample).toBe(0);
      expect(audio.timing).toBe('estimated');
      expect(Number.isNaN(Date.parse(audio.capturedAt))).toBe(false);
      const next = await helper.take('audio', 'first');
      expect(next.type).toBe('audio');
      if (next.type === 'audio') {
        expect(next.startSample).toBe(pcm.length / 2);
        expect(Date.parse(next.capturedAt) - Date.parse(audio.capturedAt)).toBeCloseTo(pcm.length / 48, 0);
      }
    }
    await runCommand('xdotool', ['key', 'ctrl+shift+space']);
    await helper.take('toggle');
    helper.send({ type: 'stop', turnId: 'first' });
    await helper.take('audio-stopped', 'first');
    await assertRecorderStopped();
    await runCommand('xdotool', ['key', 'Escape']);
    await helper.take('cancel');
    helper.send({ type: 'cancel', turnId: 'first' });
    await helper.take('audio-stopped', 'first');
    helper.send({ type: 'start', turnId: 'second' });
    await helper.take('audio-started', 'second');
    const restarted = await helper.take('audio', 'second');
    expect(restarted).toMatchObject({ startSample: 0, timing: 'estimated' });
    await runCommand('xdotool', ['key', 'Escape']);
    await helper.take('cancel');
    helper.send({ type: 'cancel', turnId: 'second' });
    await helper.take('audio-stopped', 'second');
    await assertRecorderStopped();
    // A normal finalization releases Escape; no cancellation event follows.
    helper.send({ type: 'start', turnId: 'third' });
    await helper.take('audio-started', 'third');
    helper.send({ type: 'cancel', turnId: 'previous-turn' });
    await helper.take('audio', 'third');
    expect(helper.events.some((event) => event.type === 'audio-stopped' && event.turnId === 'previous-turn')).toBe(false);
    helper.send({ type: 'stop', turnId: 'third' });
    await helper.take('audio-stopped', 'third');
    helper.send({ type: 'settled', turnId: 'third' });
    await sleep(100);
    await runCommand('xdotool', ['key', 'Escape']);
    await sleep(100);
    expect(helper.events.some((event) => event.type === 'cancel')).toBe(false);
    helper.send({ type: 'shutdown' });
    await helper.exited;
    expect((await testLinuxHotkey(1)).status).toBe('not-observed');
  }, 25_000);

  it('recovers after microphone failure and releases capture and grabs on stdin EOF', async () => {
    const helper = await voiceFixture();
    await writeFile(join(fixtureDirectory, 'fail'), '');
    helper.send({ type: 'start', turnId: 'failed' });
    expect(await helper.take('error', 'failed')).toMatchObject({ code: 'microphone-unavailable' });
    helper.send({ type: 'cancel', turnId: 'failed' });
    await helper.take('audio-stopped', 'failed');
    await rm(join(fixtureDirectory, 'fail'));
    helper.send({ type: 'start', turnId: 'retry' });
    await helper.take('audio-started', 'retry');
    helper.child.stdin.end();
    await helper.exited;
    await assertRecorderStopped();
    expect((await testLinuxHotkey(1)).status).toBe('not-observed');
  }, 20_000);

  it('cleans up an active capture and shortcut registration on SIGTERM', async () => {
    const helper = await voiceFixture();
    helper.send({ type: 'start', turnId: 'shutdown' });
    await helper.take('audio-started', 'shutdown');
    helper.child.kill('SIGTERM');
    await helper.exited;
    await assertRecorderStopped();
    expect((await testLinuxHotkey(1)).status).toBe('not-observed');
  }, 10_000);

  it('rejects malformed native commands without exposing their contents or leaving capture active', async () => {
    const helper = await voiceFixture();
    helper.send({ type: 'start', turnId: 'invalid-command' });
    await helper.take('audio-started', 'invalid-command');
    helper.child.stdin.write('{"type":"private invalid command"}\n');
    expect(await helper.take('error', 'invalid-command')).toEqual({ type: 'error', turnId: 'invalid-command', code: 'invalid-command' });
    await helper.exited;
    await assertRecorderStopped();
    expect((await testLinuxHotkey(1)).status).toBe('not-observed');
  }, 20_000);
});
