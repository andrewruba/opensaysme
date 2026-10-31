import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { access } from 'node:fs/promises';
import { CommandError, runCommand } from '../src/desktop/process.js';
import { DesktopError } from '../src/desktop/errors.js';

import {
  focusMacOS,
  captureMacOSContext,
  captureMacOSFrame,
  captureMacOSWindow,
  macOSInput,
  macOSVoiceHelper,
  macOSFeedbackHelper,
  macOSPermissions,
  parseMacOSSnapshot,
  inspectMacOS,
  listMacOSWindows,
  inspectMacOSWindow,
  probeMacOS,
  testMacOSHotkey,
  testMacOSMicrophone,
} from '../src/desktop/platforms/macos.js';

vi.mock('node:fs/promises', () => ({ access: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../src/desktop/process.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/desktop/process.js')>(), runCommand: vi.fn(),
}));

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

test('feedback resolves the optional native UI without desktop access', async () => {
  const calls = vi.mocked(runCommand).mock.calls.length;
  const helper = await macOSFeedbackHelper();
  assert.match(helper.file, /native\/macos\/bin\/opensaysme-desktop$/);
  assert.deepEqual(helper.args, ['--feedback']);
  assert.equal(vi.mocked(runCommand).mock.calls.length, calls);
});

test('permission inspection is separate from explicit local verification and validates the requested capability', async () => {
  const report = { helperPath: '/fixture/helper', bundleIdentifier: 'dev.opensaysme.desktop', launcher: null,
    desktopAvailable: true, permissions: { microphone: 'not-determined', accessibility: 'not-granted', screenCapture: 'granted' } };
  const signal = new AbortController().signal;
  vi.mocked(runCommand).mockResolvedValueOnce(JSON.stringify(report));
  assert.deepEqual(await macOSPermissions.inspect(signal), report);
  assert.deepEqual(vi.mocked(runCommand).mock.lastCall?.slice(1), [['--permissions'], { timeoutMs: 4000, signal }]);
  vi.mocked(runCommand).mockResolvedValueOnce('{"permission":"microphone","outcome":"verified"}');
  assert.deepEqual(await macOSPermissions.verify('microphone', signal), { permission: 'microphone', outcome: 'verified' });
  assert.deepEqual(vi.mocked(runCommand).mock.lastCall?.slice(1), [['--verify-permission', 'microphone'], { timeoutMs: 25000, signal }]);
  vi.mocked(runCommand).mockResolvedValueOnce('{"permission":"microphone","outcome":"verified"}');
  await assert.rejects(macOSPermissions.verify('screenCapture'), { code: 'helper-invalid-response' });
  const previous = vi.mocked(runCommand).mock.calls.length;
  await assert.rejects(macOSPermissions.inspect(AbortSignal.abort()));
  assert.equal(vi.mocked(runCommand).mock.calls.length, previous);
});

test('known transport failures keep their cause and never reuse arbitrary error text', async () => {
  for (const [reason, code] of [['timeout', 'timeout'], ['signal', 'helper-crashed'], ['spawn-failed', 'helper-unavailable']] as const) {
    vi.mocked(runCommand).mockRejectedValueOnce(new CommandError(reason));
    await assert.rejects(captureMacOSFrame(), (error: unknown) => error instanceof DesktopError && error.code === code);
  }
  vi.mocked(access).mockRejectedValueOnce(new Error('private path'));
  await assert.rejects(macOSPermissions.inspect(), { code: 'helper-missing' });
  vi.mocked(runCommand).mockRejectedValueOnce(new CommandError('timeout'));
  const report = await probeMacOS();
  assert.match(report.capabilities.screenCapture.detail, /timed out/);
  assert.ok(!report.capabilities.screenCapture.detail.includes('Enable Screen Recording'));
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

test('screen capture preserves the native deadline as a typed timeout instead of capture failure', async () => {
  vi.mocked(runCommand).mockResolvedValueOnce('{"error":"screen-capture-timeout"}');
  await assert.rejects(captureMacOSFrame(), (error: unknown) => error instanceof DesktopError
    && error.code === 'screen-capture-timeout' && error.message.includes('timed out'));
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

test('mouse/keyboard adapters send typed payloads over stdin and validate native evidence and outcomes', async () => {
  const target = { windowId: inspectionId, bounds: windowFrame.bounds, point: { x: -1100, y: 0 } };
  const action = { kind: 'type_text' as const, text: 'private input $(literal)\r\n\tstack trace\n日本語 👋\u2028last line' };
  const evidence = { fingerprint: 'a'.repeat(64), role: 'AXTextArea', title: 'Agent input', description: '', value: '',
    bounds: { x: -1100, y: 0, width: 100, height: 30 }, focused: true, editable: true };
  const signal = new AbortController().signal;
  vi.mocked(runCommand).mockResolvedValueOnce(JSON.stringify(evidence));
  assert.deepEqual(await macOSInput.inspect(target, action, signal), evidence);
  assert.deepEqual(vi.mocked(runCommand).mock.lastCall?.slice(1), [['--inspect-input'], {
    input: JSON.stringify({ target, action, fingerprint: null }), timeoutMs: 3000, signal,
  }]);
  vi.mocked(runCommand).mockResolvedValueOnce('{"status":"not-issued"}');
  assert.deepEqual(await macOSInput.execute(target, action, evidence.fingerprint, signal), { status: 'not-issued' });
  assert.deepEqual(vi.mocked(runCommand).mock.lastCall?.[1], ['--execute-input']);
  assert.equal(JSON.parse(vi.mocked(runCommand).mock.lastCall![2]!.input!).action.text, action.text);
  assert.equal(vi.mocked(runCommand).mock.lastCall![1].some((argument) => argument.includes('private input')), false);
  const calls = vi.mocked(runCommand).mock.calls.length;
  await assert.rejects(macOSInput.execute(target, { kind: 'type_text', text: '\u001b' }, evidence.fingerprint, signal));
  await assert.rejects(macOSInput.execute(target, action, 'forged', signal));
  await assert.rejects(macOSInput.inspect(target, action, AbortSignal.abort()));
  assert.equal(vi.mocked(runCommand).mock.calls.length, calls);
  vi.mocked(runCommand).mockResolvedValueOnce('{"status":"success","private":"data"}');
  await assert.rejects(macOSInput.execute(target, action, evidence.fingerprint, signal), /invalid response/);
});

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

test('window capture distinguishes a crashed helper from timeout and caller cancellation', async () => {
  vi.mocked(runCommand).mockRejectedValueOnce(new CommandError('signal', { signal: 'SIGABRT' }));
  assert.deepEqual(await captureMacOSWindow(inspectionId), { status: 'unavailable', reason: 'helper-crashed' });
  vi.mocked(runCommand).mockRejectedValueOnce(new CommandError('timeout'));
  assert.deepEqual(await captureMacOSWindow(inspectionId), { status: 'unavailable', reason: 'timeout' });
  const controller = new AbortController();
  vi.mocked(runCommand).mockImplementationOnce(async () => {
    controller.abort(); throw new CommandError('signal', { signal: 'SIGTERM' });
  });
  await assert.rejects(captureMacOSWindow(inspectionId, controller.signal), { name: 'AbortError' });
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
