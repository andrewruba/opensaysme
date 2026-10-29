import assert from 'node:assert/strict';
import { test, vi } from 'vitest';

import { captureWindowsContext, captureWindowsFrame, focusWindows, parseWindowsSnapshot, probeWindows, testWindowsHotkey, testWindowsMicrophone, windowsVoiceHelper } from '../src/desktop/platforms/windows.js';
import { runCommand } from '../src/desktop/process.js';

vi.mock('../src/desktop/process.js', () => ({ runCommand: vi.fn() }));

test('parses Windows handles and preserves optional selection without guessing', () => {
  const response = {
    version: 1,
    operation: 'inspect',
    window: { id: 'win32:123:456', application: 'Terminal', title: 'A terminal' },
    selectedText: 'selected context',
  };
  assert.deepEqual(parseWindowsSnapshot(JSON.stringify(response)), {
    platform: 'win32', window: response.window, selectedText: 'selected context',
  });
  assert.deepEqual(parseWindowsSnapshot('{"version":1,"operation":"inspect","window":null}'), {
    platform: 'win32', window: null,
  });
});

test('rejects malformed helper output without echoing captured content', () => {
  for (const output of [
    'private selection that is not JSON',
    JSON.stringify({ version: 1, operation: 'inspect', window: null, selectedText: 123 }),
    JSON.stringify({ version: 1, operation: 'inspect', window: { id: 'win32:123:9999999999999999999', application: 'Terminal', title: '' } }),
  ]) {
    assert.throws(() => parseWindowsSnapshot(output), {
      message: 'The Windows desktop helper returned an invalid response.',
    });
  }
});

test('rejects untrusted focus IDs before launching PowerShell', async () => {
  for (const id of ['123', 'win32:1:0', 'win32:1:3; calc.exe', 'win32:4294967296:1', 'win32:1:9999999999999999999']) {
    await assert.rejects(focusWindows(id), { message: 'Use a Windows window ID returned by desktop inspect.' });
  }
});

test('surfaces known native failures without echoing helper content', () => {
  assert.throws(() => parseWindowsSnapshot('{"version":1,"operation":"error","code":"selection-unavailable"}'), {
    message: 'The focused Windows control does not expose selected text through UI Automation.',
  });
});

test('rejects invalid capture durations before launching a native process', async () => {
  for (const duration of [0, 31, 1.5, NaN]) {
    await assert.rejects(testWindowsHotkey(duration), { message: 'Desktop tests must run for 1 to 30 seconds.' });
    await assert.rejects(testWindowsMicrophone(duration), { message: 'Desktop tests must run for 1 to 30 seconds.' });
  }
});

test('doctor reports blocked helpers without disclosing native error output', async () => {
  vi.mocked(runCommand).mockRejectedValueOnce(new Error('private native error details'));
  const report = await probeWindows();
  assert.ok(Object.values(report.capabilities).every((capability) => capability.status === 'unavailable'));
  assert.ok(report.notes.some((note) => note.includes('Get-ExecutionPolicy -List')));
  assert.equal(JSON.stringify(report).includes('private native error'), false);
});

test('doctor keeps focus and capture unverified until explicitly tested', async () => {
  vi.mocked(runCommand).mockResolvedValueOnce('{"version":1,"operation":"probe","interactive":true,"automation":true,"screenCapture":true}');
  const report = await probeWindows();
  assert.equal(report.capabilities.activeWindow.status, 'available');
  for (const capability of ['focusWindow', 'selectedText', 'globalHotkey', 'microphone', 'screenCapture'] as const) {
    assert.equal(report.capabilities[capability].status, 'unverified');
  }
});

test('screen capture preserves negative physical monitor coordinates and bounded image dimensions', async () => {
  const frame = {
    capturedAt: '2026-10-28T10:00:00.000Z',
    display: { id: '\\\\.\\DISPLAY2', bounds: { x: -3200, y: 0, width: 3200, height: 1800 } },
    image: { mimeType: 'image/jpeg', width: 1600, height: 900, data: '/9j/2Q==' }, warnings: [],
  };
  vi.mocked(runCommand).mockResolvedValueOnce(JSON.stringify(frame));
  const signal = new AbortController().signal;
  assert.deepEqual(await captureWindowsFrame(signal), frame);
  const call = vi.mocked(runCommand).mock.lastCall!;
  assert.match(call[1][4]!, /native[/\\]windows[/\\]frame\.ps1$/);
  assert.equal(call[2]?.signal, signal);
});

test('screen capture rejects missing, malformed, or oversized output without echoing pixels', async () => {
  for (const output of ['private image data', '{"error":"screen-capture-unavailable"}', JSON.stringify({
    capturedAt: '2026-10-28T10:00:00.000Z',
    display: { id: '\\\\.\\DISPLAY1', bounds: { x: 0, y: 0, width: 3200, height: 1800 } },
    image: { mimeType: 'image/jpeg', width: 3200, height: 1800, data: '/9j/2Q==' }, warnings: [],
  })]) {
    vi.mocked(runCommand).mockResolvedValueOnce(output);
    await assert.rejects(captureWindowsFrame(), /Windows screen capture is unavailable or invalid/);
  }
});

test('captures separate foreground and pointer windows without losing selection whitespace', async () => {
  const snapshot = {
    platform: 'win32', capturedAt: '2026-10-28T10:00:00.000Z',
    activeWindow: { id: 'win32:123:456', application: 'Terminal', title: 'Agent' },
    selectedText: '  selected context\n',
    pointer: { x: -100, y: 20, window: { id: 'win32:456:789', application: 'Browser', title: 'Reference' } },
    warnings: [],
  };
  vi.mocked(runCommand).mockResolvedValueOnce(JSON.stringify(snapshot));
  const controller = new AbortController();
  assert.deepEqual(await captureWindowsContext(controller.signal), snapshot);
  const call = vi.mocked(runCommand).mock.lastCall!;
  assert.deepEqual(call[1].slice(-2), ['-Operation', 'context']);
  assert.equal(call[2]?.signal, controller.signal);
});

test('accepts missing optional context with explicit warnings', async () => {
  const snapshot = {
    platform: 'win32', capturedAt: '2026-10-28T10:00:00.0000000Z',
    activeWindow: null, warnings: ['Pointer position was unavailable.'],
  };
  vi.mocked(runCommand).mockResolvedValueOnce(JSON.stringify(snapshot));
  assert.deepEqual(await captureWindowsContext(), snapshot);
});

test('validates captured window IDs and context without leaking private output', async () => {
  for (const invalid of [
    'private non-JSON output',
    JSON.stringify({
      platform: 'win32', capturedAt: '2026-10-28T10:00:00.000Z', activeWindow: null,
      selectedText: 'private selection', pointer: { x: 0, y: 0, window: { id: 'bad-id', application: 'private title', title: '' } }, warnings: [],
    }),
    JSON.stringify({ platform: 'win32', capturedAt: 'invalid', activeWindow: null, warnings: [] }),
  ]) {
    vi.mocked(runCommand).mockResolvedValueOnce(invalid);
    await assert.rejects(captureWindowsContext(), { message: 'The Windows desktop helper returned an invalid response.' });
  }
});

test('persistent helper uses a fixed PowerShell script and respects execution policy', async () => {
  const helper = await windowsVoiceHelper();
  assert.equal(helper.file, 'powershell.exe');
  assert.deepEqual(helper.args.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-File']);
  assert.match(helper.args[4]!, /native[/\\]windows[/\\]voice\.ps1$/);
  assert.equal(helper.args.length, 5);
});
