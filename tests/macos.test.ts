import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { access } from 'node:fs/promises';
import { runCommand } from '../src/desktop/process.js';

import {
  focusMacOS,
  captureMacOSContext,
  captureMacOSFrame,
  captureMacOSWindow,
  macOSVoiceHelper,
  parseMacOSSnapshot,
  inspectMacOS,
  listMacOSWindows,
  inspectMacOSWindow,
  probeMacOS,
  testMacOSHotkey,
  testMacOSMicrophone,
} from '../src/desktop/platforms/macos.js';

vi.mock('node:fs/promises', () => ({ access: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../src/desktop/process.js', () => ({ runCommand: vi.fn() }));

test('doctor reports missing helper prerequisites without recursing into doctor', async () => {
  vi.mocked(access).mockRejectedValueOnce(new Error('missing native binary'));
  const report = await probeMacOS();
  assert.equal(report.session, 'not assessed');
  assert.equal(report.capabilities.activeWindow.status, 'unavailable');
  assert.match(report.capabilities.activeWindow.detail, /npm run build:native/);
});

test('doctor rejects malformed helper reports without leaking native contents', async () => {
  vi.mocked(runCommand).mockResolvedValueOnce('{"private":"sensitive-window"}');
  const report = await probeMacOS();
  assert.equal(report.capabilities.activeWindow.status, 'unavailable');
  assert.ok(!JSON.stringify(report).includes('sensitive-window'));
});

test('macOS snapshot validates targets and keeps selection optional', () => {
  const snapshot = {
    platform: 'darwin',
    window: { id: `mac:123:1700000000000:${'a'.repeat(64)}`, application: 'Terminal', title: 'Agent' },
  };
  assert.deepEqual(parseMacOSSnapshot(JSON.stringify(snapshot)), snapshot);
  assert.deepEqual(parseMacOSSnapshot('{"platform":"darwin","window":null}'), { platform: 'darwin', window: null });
  assert.throws(() => parseMacOSSnapshot(JSON.stringify({ ...snapshot, platform: 'win32' })), /invalid window target/);
  assert.throws(() => parseMacOSSnapshot(JSON.stringify({ ...snapshot, window: { ...snapshot.window, id: 'mac:1:0:bad' } })), /invalid window target/);
});

test('malformed native messages do not disclose captured text', () => {
  assert.throws(() => parseMacOSSnapshot('{"selectedText":"private selection"}'), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, 'The macOS desktop helper returned an invalid response.');
    return true;
  });
  assert.throws(() => parseMacOSSnapshot('{"error":"private selection"}'), {
    message: 'The macOS desktop helper failed with an unknown error.',
  });
  assert.throws(() => parseMacOSSnapshot('{"error":"__proto__"}'), {
    message: 'The macOS desktop helper failed with an unknown error.',
  });
});

test('expected native failures explain remediation without arbitrary helper text', () => {
  assert.throws(() => parseMacOSSnapshot('{"error":"stale-or-ambiguous-target"}'), /Window target is stale or ambiguous/);
  assert.throws(() => parseMacOSSnapshot('{"error":"secure-field"}'), /secure text fields/);
});

test('invalid focus identifiers are rejected before launching a helper', async () => {
  await assert.rejects(focusMacOS('mac:1;touch /tmp/unwanted'), /Use a macOS window ID/);
  await assert.rejects(focusMacOS(`mac:9999999999:1700000000000:${'a'.repeat(64)}`), /Use a macOS window ID/);
});

test('interactive native tests reject unbounded durations before launching', async () => {
  await assert.rejects(testMacOSHotkey(0), /integer from 1 to 30/);
  await assert.rejects(testMacOSMicrophone(31), /integer from 1 to 30/);
  await assert.rejects(testMacOSMicrophone(Number.NaN), /integer from 1 to 30/);
});

test('voice resolves a built helper without opening the microphone', async () => {
  const previous = vi.mocked(runCommand).mock.calls.length;
  const helper = await macOSVoiceHelper();
  assert.match(helper.file, /native\/macos\/bin\/opensaysme-desktop$/);
  assert.deepEqual(helper.args, ['--voice']);
  assert.equal(vi.mocked(runCommand).mock.calls.length, previous);
});

test('context accepts partial desktop access and passes cancellation to the helper', async () => {
  const signal = new AbortController().signal;
  const context = {
    platform: 'darwin', capturedAt: '2026-10-28T12:00:00Z', activeWindow: null,
    pointer: { x: -10, y: 20, window: null }, warnings: ['Accessibility permission required.'],
  };
  vi.mocked(runCommand).mockResolvedValueOnce(JSON.stringify(context));
  assert.deepEqual(await captureMacOSContext(signal), context);
  assert.deepEqual(vi.mocked(runCommand).mock.lastCall?.slice(1), [['--context'], { timeoutMs: 4000, signal }]);
});

test('context validates pointer targets and omits private malformed response details', async () => {
  vi.mocked(runCommand).mockResolvedValueOnce(JSON.stringify({
    platform: 'darwin', capturedAt: '2026-10-28T12:00:00Z', activeWindow: null,
    pointer: { x: 1, y: 2, window: { id: 'private-title', application: 'private-app' } }, warnings: [],
  }));
  await assert.rejects(captureMacOSContext(), { message: 'The macOS desktop helper returned an invalid context target.' });
  vi.mocked(runCommand).mockResolvedValueOnce('{"selectedText":"private-selection"}');
  await assert.rejects(captureMacOSContext(), { message: 'The macOS desktop helper returned an invalid response.' });
});

test('screen frames preserve display coordinates and pass cancellation without writing files', async () => {
  const signal = new AbortController().signal;
  const frame = {
    capturedAt: '2026-10-28T12:00:00.123Z',
    display: { id: '2', bounds: { x: -1920, y: -200, width: 1920, height: 1080 } },
    image: { mimeType: 'image/jpeg', width: 1600, height: 900, data: '/9j/2Q==' }, warnings: [],
  };
  vi.mocked(runCommand).mockResolvedValueOnce(JSON.stringify(frame));
  assert.deepEqual(await captureMacOSFrame(signal), frame);
  assert.deepEqual(vi.mocked(runCommand).mock.lastCall?.slice(1), [['--frame'], { timeoutMs: 4000, signal }]);
  vi.mocked(runCommand).mockResolvedValueOnce(JSON.stringify({ ...frame, display: { ...frame.display, id: 'private-display' } }));
  await assert.rejects(captureMacOSFrame(), { message: 'The macOS desktop helper returned an invalid screen display.' });
});

test('screen frame errors explain permission and platform limits without exposing image data', async () => {
  vi.mocked(runCommand).mockResolvedValueOnce('{"error":"screen-permission-required"}');
  await assert.rejects(captureMacOSFrame(), /Enable Screen Recording/);
  vi.mocked(runCommand).mockResolvedValueOnce('{"error":"screen-capture-unavailable"}');
  await assert.rejects(captureMacOSFrame(), /macOS 14 or later/);
  vi.mocked(runCommand).mockResolvedValueOnce('{"image":"private-pixels"}');
  await assert.rejects(captureMacOSFrame(), { message: 'The macOS desktop helper returned an invalid response.' });
});

test('macOS inventory preserves distinct windows and forwards cancellation without focusing', async () => {
  const inventory = { windows: ['a', 'b'].map((digest) => ({
    id: `mac:123:1700000000000:${digest.repeat(64)}`, application: 'Code', title: `${digest} project`,
  })), warnings: ['Some inaccessible or ambiguous windows were omitted.'] };
  const signal = new AbortController().signal;
  vi.mocked(runCommand).mockResolvedValueOnce(JSON.stringify(inventory));
  assert.deepEqual(await listMacOSWindows(signal), inventory);
  assert.deepEqual(vi.mocked(runCommand).mock.lastCall?.slice(1), [['--list-windows'], { timeoutMs: 4000, signal }]);
});

test('macOS inventory rejects duplicate, excessive, or invalid native targets', async () => {
  const window = { id: `mac:123:1700000000000:${'a'.repeat(64)}`, application: 'Code' };
  for (const windows of [[window, window], Array(129).fill(window), [{ ...window, id: 'private invalid target' }]]) {
    vi.mocked(runCommand).mockResolvedValueOnce(JSON.stringify({ windows, warnings: [] }));
    await assert.rejects(listMacOSWindows(), /invalid/);
  }
  vi.mocked(runCommand).mockResolvedValueOnce('{"error":"permission-required"}');
  await assert.rejects(listMacOSWindows(), /Enable Accessibility/);
});

test('macOS inspection and focus pass cancellation and never launch after abort', async () => {
  const id = `mac:123:1700000000000:${'a'.repeat(64)}`;
  const signal = new AbortController().signal;
  vi.mocked(runCommand).mockResolvedValueOnce('{"platform":"darwin","window":null}');
  await inspectMacOS(false, signal);
  assert.equal(vi.mocked(runCommand).mock.lastCall?.[2]?.signal, signal);
  vi.mocked(runCommand).mockResolvedValueOnce('{"ok":true}');
  await focusMacOS(id, signal);
  assert.equal(vi.mocked(runCommand).mock.lastCall?.[2]?.signal, signal);
  const previous = vi.mocked(runCommand).mock.calls.length;
  for (const operation of [() => listMacOSWindows(AbortSignal.abort()), () => inspectMacOS(false, AbortSignal.abort()), () => focusMacOS(id, AbortSignal.abort())]) {
    await assert.rejects(operation());
  }
  assert.equal(vi.mocked(runCommand).mock.calls.length, previous);
});

const inspectionId = `mac:123:1700000000000:${'a'.repeat(64)}`;
const inspection = {
  status: 'ok', capturedAt: '2026-10-29T12:00:00Z',
  window: { id: inspectionId, application: 'Code', title: 'Project' },
  nodes: [{ parent: null, role: 'AXWindow' }, { parent: 0, role: 'AXTextArea', value: 'frontend/App.tsx' }], warnings: [],
};

const windowFrame = {
  status: 'ok', capturedAt: '2026-10-29T12:00:00Z', window: inspection.window,
  bounds: { x: -1200, y: -100, width: 800, height: 600 },
  image: { mimeType: 'image/jpeg', width: 1600, height: 1200, data: '/9j/AA==' }, warnings: [],
};

test('window capture keeps its source and coordinate metadata and propagates cancellation', async () => {
  const signal = new AbortController().signal;
  vi.mocked(runCommand).mockResolvedValueOnce(JSON.stringify(windowFrame));
  assert.deepEqual(await captureMacOSWindow(inspectionId, signal), windowFrame);
  assert.deepEqual(vi.mocked(runCommand).mock.lastCall?.slice(1), [['--capture-window', inspectionId], { timeoutMs: 5000, signal }]);
  const previous = vi.mocked(runCommand).mock.calls.length;
  await assert.rejects(captureMacOSWindow('not-a-window'));
  await assert.rejects(captureMacOSWindow(inspectionId, AbortSignal.abort()));
  assert.equal(vi.mocked(runCommand).mock.calls.length, previous);
});

test('window capture rejects mismatched sources and malformed image/coordinate responses', async () => {
  for (const result of [
    { ...windowFrame, window: { ...windowFrame.window, id: `mac:123:1700000000000:${'b'.repeat(64)}` } },
    { ...windowFrame, bounds: { ...windowFrame.bounds, width: 0 } },
    { ...windowFrame, bounds: { ...windowFrame.bounds, x: 'private malformed coordinate' } },
    { ...windowFrame, image: { ...windowFrame.image, width: 1601 } },
    { ...windowFrame, image: { ...windowFrame.image, data: 'private malformed pixels' } },
    { ...windowFrame, capturedAt: 'not a date' },
  ]) {
    vi.mocked(runCommand).mockResolvedValueOnce(JSON.stringify(result));
    await assert.rejects(captureMacOSWindow(inspectionId), /invalid response|mismatched window/);
  }
});

test('window capture preserves permission, stale, ambiguous, platform, and timeout failures', async () => {
  for (const [code, reason] of [
    ['permission-required', 'accessibility-permission-required'], ['screen-permission-required', 'screen-permission-required'],
    ['stale-or-ambiguous-target', 'stale-target'], ['window-capture-stale', 'stale-target'],
    ['window-capture-ambiguous', 'ambiguous-target'], ['window-capture-unavailable', 'inaccessible'],
    ['window-capture-unsupported', 'unsupported'], ['window-capture-timeout', 'timeout'], ['window-capture-failed', 'capture-failed'],
  ]) {
    vi.mocked(runCommand).mockResolvedValueOnce(JSON.stringify({ error: code }));
    assert.deepEqual(await captureMacOSWindow(inspectionId), { status: 'unavailable', reason });
  }
  vi.mocked(runCommand).mockResolvedValueOnce('{"error":"private pixels"}');
  await assert.rejects(captureMacOSWindow(inspectionId), { message: 'The macOS desktop helper failed with an unknown error.' });
});

test('window inspection is bounded, targeted, and cancellable without requesting focus', async () => {
  const signal = new AbortController().signal;
  vi.mocked(runCommand).mockResolvedValueOnce(JSON.stringify(inspection));
  assert.deepEqual(await inspectMacOSWindow(inspectionId, signal), inspection);
  assert.deepEqual(vi.mocked(runCommand).mock.lastCall?.slice(1), [['--inspect-window', inspectionId], { timeoutMs: 4000, signal }]);
  const previous = vi.mocked(runCommand).mock.calls.length;
  await assert.rejects(inspectMacOSWindow('not-a-window'));
  await assert.rejects(inspectMacOSWindow(inspectionId, AbortSignal.abort()));
  assert.equal(vi.mocked(runCommand).mock.calls.length, previous);
});

test('window inspection rejects mismatched identity, invalid parentage, and excessive text', async () => {
  for (const result of [
    { ...inspection, window: { ...inspection.window, id: `mac:123:1700000000000:${'b'.repeat(64)}` } },
    { ...inspection, nodes: [{ parent: 0, role: 'AXWindow' }] },
    { ...inspection, nodes: [{ parent: null, role: 'AXTextArea', value: 'x'.repeat(2049) }] },
    { ...inspection, nodes: Array.from({ length: 9 }, () => ({ parent: null, role: 'AXTextArea', value: 'x'.repeat(2048) })) },
    { ...inspection, nodes: Array.from({ length: 129 }, () => ({ parent: null, role: 'AXButton' })) },
    { ...inspection, capturedAt: 'private malformed timestamp' },
  ]) {
    vi.mocked(runCommand).mockResolvedValueOnce(JSON.stringify(result));
    await assert.rejects(inspectMacOSWindow(inspectionId), /invalid response|mismatched window/);
  }
});

test('window inspection returns known failure reasons without leaking arbitrary native errors', async () => {
  for (const [code, reason] of [
    ['permission-required', 'permission-required'], ['stale-or-ambiguous-target', 'stale-target'],
    ['invalid-target', 'stale-target'], ['accessibility-unavailable', 'inaccessible'],
  ]) {
    vi.mocked(runCommand).mockResolvedValueOnce(JSON.stringify({ error: code }));
    assert.deepEqual(await inspectMacOSWindow(inspectionId), { status: 'unavailable', reason });
  }
  vi.mocked(runCommand).mockResolvedValueOnce('{"error":"private-window-content"}');
  await assert.rejects(inspectMacOSWindow(inspectionId), { message: 'The macOS desktop helper failed with an unknown error.' });
});
