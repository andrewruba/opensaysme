import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { access } from 'node:fs/promises';
import { runCommand } from '../src/desktop/process.js';

import {
  focusMacOS,
  parseMacOSSnapshot,
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
