import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { focusLinux, inspectLinux, probeLinux, testLinuxHotkey } from '../src/desktop/platforms/linux.js';
import { runCommand } from '../src/desktop/process.js';

// Run only in an explicitly opted-in virtual display, never the user's desktop.
const enabled = process.env.OPENSAYSME_X11_TEST === '1' && process.platform === 'linux';
describe.skipIf(!enabled)('Linux X11 virtual desktop integration', () => {
  const fixtures: ChildProcess[] = [];
  const fixtureMessages: string[] = [];
  const titles = ['OpenSaysMe fixture one', 'OpenSaysMe fixture two'];
  let firstWindow: string;
  let secondWindow: string;

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
  }, 40_000);

  afterAll(async () => {
    await Promise.all(fixtures.reverse().map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      const forceKill = setTimeout(() => child.kill('SIGKILL'), 500);
      try { await exited; } finally { clearTimeout(forceKill); }
    }));
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
});
