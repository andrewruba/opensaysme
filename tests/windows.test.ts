import assert from 'node:assert/strict';
import { test, vi } from 'vitest';

import { focusWindows, parseWindowsSnapshot, probeWindows, testWindowsHotkey, testWindowsMicrophone } from '../src/desktop/platforms/windows.js';
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
  vi.mocked(runCommand).mockResolvedValueOnce('{"version":1,"operation":"probe","interactive":true,"automation":true}');
  const report = await probeWindows();
  assert.equal(report.capabilities.activeWindow.status, 'available');
  for (const capability of ['focusWindow', 'selectedText', 'globalHotkey', 'microphone'] as const) {
    assert.equal(report.capabilities[capability].status, 'unverified');
  }
});
