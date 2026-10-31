import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDesktopTools } from '../src/tools/desktop.js';
import { createTextTools } from '../src/tools/text.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { textCaptureSchema, type TextCapture } from '../src/desktop/text-types.js';
import type { DesktopAdapter, WindowFrameCapture } from '../src/desktop/types.js';
import type { DesktopInputAdapter } from '../src/desktop/input-types.js';
import type { ToolResult } from '../src/tools/types.js';

const signal = () => new AbortController().signal;
const value = (result: ToolResult) => {
  const first = result.content[0]; if (first?.type !== 'text') throw new Error('Expected text result.');
  return JSON.parse(first.text);
};
const capture = (text = 'old session\nSTART current session\n日本語 👋\r\n\tlast line', start = 0): TextCapture => ({
  capturedAt: '2026-10-31T16:00:00Z', application: 'Terminal', windowTitle: 'project — shell',
  role: 'AXTextArea', title: '', description: 'shell', text, start, totalLength: start + text.length,
});
const frame: Extract<WindowFrameCapture, { status: 'ok' }> = {
  status: 'ok', capturedAt: '2026-10-31T16:01:00Z', window: { id: 'native-destination', application: 'Agent', title: 'Project' },
  bounds: { x: 0, y: 0, width: 800, height: 600 },
  image: { width: 800, height: 600, mimeType: 'image/jpeg', data: '/9j/AA==' }, warnings: [],
};
const evidence = { fingerprint: 'a'.repeat(64), role: 'AXTextArea', title: 'Prompt', description: '', value: 'existing draft',
  bounds: { x: 100, y: 100, width: 400, height: 200 }, editable: true, focused: true };
function fixture(request = 'Copy this session into the agent input, leaving it unsent.', source = capture()) {
  const readText = vi.fn<NonNullable<DesktopAdapter['readText']>>(async () => structuredClone(source));
  const input = {
    inspect: vi.fn<DesktopInputAdapter['inspect']>(async () => structuredClone(evidence)),
    execute: vi.fn<DesktopInputAdapter['execute']>(async () => ({ status: 'verified' })),
  };
  const adapter = {
    readText, input,
    listWindows: vi.fn<DesktopAdapter['listWindows']>(async () => ({ windows: [frame.window], warnings: [] })),
    captureWindow: vi.fn<NonNullable<DesktopAdapter['captureWindow']>>(async () => structuredClone(frame)),
    inspect: vi.fn<DesktopAdapter['inspect']>(async () => ({ platform: 'test', window: frame.window })),
    focus: vi.fn<DesktopAdapter['focus']>(async () => {}),
    captureContext: vi.fn<DesktopAdapter['captureContext']>(), captureFrame: vi.fn<DesktopAdapter['captureFrame']>(),
  };
  const authorize = vi.fn(async () => { throw new Error('Literal text transfer must not call a guard.'); });
  const host = createDesktopTools(adapter, { request, authorize });
  const call = (name: string, args: Record<string, unknown> = {}) => host.call(name, args, signal());
  const destination = async () => {
    await call('list_windows');
    return value(await call('capture_window', { windowId: 'window-1' })).observationId as string;
  };
  return { host, adapter, input, readText, authorize, call, destination };
}
afterEach(() => { vi.restoreAllMocks(); });

describe('retained text snapshots', () => {
  it('advertises text capabilities only when their adapters exist', () => {
    const f = fixture();
    const readOnly = createDesktopTools({ ...f.adapter, input: undefined });
    const unsupported = createDesktopTools({ ...f.adapter, readText: undefined });
    expect(readOnly.list().map(({ name }) => name)).toEqual(expect.arrayContaining(['capture_text', 'read_text']));
    expect(readOnly.list().map(({ name }) => name)).not.toContain('transfer_text');
    expect(unsupported.list().map(({ name }) => name)).not.toEqual(expect.arrayContaining(['capture_text']));
    f.host.close(); readOnly.close(); unsupported.close();
  });

  it('returns a bounded recent tail with honest source bounds and no surrogate split', async () => {
    const source = capture('old history'.repeat(1000) + '👋' + 'x'.repeat(4095), 1200);
    const f = fixture(undefined, source);
    const result = value(await f.call('capture_text'));
    expect(result).toMatchObject({ application: 'Terminal', windowTitle: 'project — shell', role: 'AXTextArea',
      totalLength: source.totalLength, retainedStart: 1200, retainedEnd: source.totalLength, truncated: true,
      preview: { start: source.totalLength - 4095, end: source.totalLength, text: 'x'.repeat(4095) } });
    expect(result.warnings).toHaveLength(1);
    expect(result).not.toHaveProperty('text');
    expect(f.adapter.focus).not.toHaveBeenCalled(); expect(f.input.execute).not.toHaveBeenCalled(); f.host.close();
  });

  it('pages immutable ranges and finds literal session markers with absolute offsets', async () => {
    const source = capture('old session\n[START.*] current\nfirst\nlast', 500);
    const f = fixture(undefined, source);
    const { sourceId } = value(await f.call('capture_text'));
    source.text = 'changed live app';
    const result = value(await f.call('read_text', { sourceId, offset: 512, length: 9, query: '[START.*]' }));
    expect(result).toMatchObject({ text: '[START.*]', start: 512, end: 521,
      matches: [{ start: 512, end: 521 }], matchesTruncated: false });
    expect(f.readText).toHaveBeenCalledOnce(); f.host.close();
  });

  it('bounds literal search results and distinguishes no match', async () => {
    const f = fixture(undefined, capture('marker\n'.repeat(80)));
    const { sourceId } = value(await f.call('capture_text'));
    const result = value(await f.call('read_text', { sourceId, offset: 0, length: 0, query: 'marker' }));
    expect(result.matches).toHaveLength(32); expect(result.matchesTruncated).toBe(true);
    expect(result.matches.at(-1)).toEqual({ start: 79 * 7, end: 79 * 7 + 6 });
    expect(value(await f.call('read_text', { sourceId, offset: 0, length: 0, query: '.*' }))).toMatchObject({ matches: [], matchesTruncated: false });
    f.host.close();
  });

  it('rejects missing, omitted, out-of-bounds, oversized and surrogate-splitting ranges', async () => {
    const f = fixture(undefined, capture('a👋b', 100));
    const { sourceId } = value(await f.call('capture_text'));
    for (const args of [
      { offset: 99, length: 1 }, { offset: 104, length: 1 }, { offset: 102, length: 1 }, { offset: 100, length: 2 },
    ]) expect(value(await f.call('read_text', { sourceId, ...args, query: null })).code).toBe('invalid-text-range');
    for (const args of [{ offset: 100, length: 4097, query: null }, { offset: 100, length: 1 },
      { offset: 100, length: 1, query: '\ud800' }]) {
      expect(value(await f.call('read_text', { sourceId, ...args })).code).toBe('invalid-arguments');
    }
    expect(value(await f.call('read_text', { sourceId, offset: 101, length: 2, query: null })).text).toBe('👋');
    f.host.close();
  });

  it('replaces old snapshots and does not reuse references between turns', async () => {
    const f = fixture(); const other = fixture();
    const old = value(await f.call('capture_text')).sourceId;
    const current = value(await f.call('capture_text')).sourceId;
    await other.call('capture_text');
    for (const [host, sourceId] of [[f.host, old], [other.host, current]] as const) {
      expect(value(await host.call('read_text', { sourceId, offset: 0, length: 1, query: null }, signal())).code).toBe('stale-text-source');
    }
    f.readText.mockRejectedValueOnce(new Error('private captured failure'));
    expect(value(await f.call('capture_text')).code).toBe('tool-failed');
    expect(value(await f.call('read_text', { sourceId: current, offset: 0, length: 1, query: null })).code).toBe('stale-text-source');
    f.host.close(); other.host.close();
  });

  it('clears on close and never installs a late cancelled native capture', async () => {
    let resolve!: (result: TextCapture) => void;
    const readText = vi.fn(async () => new Promise<TextCapture>((done) => { resolve = done; }));
    const texts = createTextTools(readText);
    const host = new ToolRegistry(texts.definitions);
    const controller = new AbortController();
    const pending = host.call('capture_text', {}, controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve(); controller.abort(); await rejected;
    texts.close(); host.close(); resolve(capture()); await Promise.resolve();
    const direct = await texts.definitions[0]!.run({}, signal());
    expect(value(direct).code).toBe('stale-text-source'); expect(readText).toHaveBeenCalledOnce();
  });

  it('validates suffix consistency, Unicode and native text bounds before retention', async () => {
    const source = capture('👋'.repeat(32_768), 10);
    expect(textCaptureSchema.safeParse(source).success).toBe(true);
    const invalid = [capture('x'.repeat(65_537)), capture('\ud800'), { ...source, start: 11 },
      { ...source, totalLength: -1 }, { ...source, windowTitle: 'x'.repeat(1025) }];
    const f = fixture();
    for (const data of invalid) {
      f.readText.mockResolvedValueOnce(data);
      const result = await f.call('capture_text');
      expect(value(result).code).toBe('tool-failed');
      expect(JSON.stringify(result)).not.toContain('👋');
    }
    f.host.close();
  });
});

describe('exact text transfer', () => {
  it('transfers the full retained Unicode bound while keeping model-authored text small', async () => {
    const source = capture('👋'.repeat(32_768));
    const f = fixture(undefined, source);
    const { sourceId } = value(await f.call('capture_text'));
    const destinationObservationId = await f.destination();
    expect(value(await f.call('type_text', { observationId: destinationObservationId, x: 100, y: 100, text: source.text })).code).toBe('invalid-arguments');
    expect(value(await f.call('transfer_text', { sourceId, start: 0, end: 65_536, destinationObservationId, x: 100, y: 100 })).status).toBe('verified');
    expect(f.input.execute.mock.calls[0]?.[1]).toEqual({ kind: 'type_text', text: source.text }); f.host.close();
  });

  it('copies a large selected session exactly through native input without a model guard or text echo', async () => {
    const selected = 'current session\r\n\t日本語 👋\n'.repeat(1800);
    const source = capture('earlier session\n' + selected, 200);
    const f = fixture(undefined, source);
    const { sourceId } = value(await f.call('capture_text'));
    const destinationObservationId = await f.destination();
    const args = { sourceId, start: 216, end: source.totalLength, destinationObservationId, x: 200, y: 150 };
    expect(f.host.feedbackTarget!('transfer_text', args)).toEqual({ application: 'Agent', title: 'Project' });
    const result = await f.call('transfer_text', args);
    expect(value(result)).toMatchObject({ status: 'verified', effect: 'edit', inputStopped: false });
    expect(f.input.execute).toHaveBeenCalledWith({ windowId: frame.window.id, bounds: frame.bounds, point: { x: 200, y: 150 } },
      { kind: 'type_text', text: selected }, evidence.fingerprint, expect.any(AbortSignal));
    expect(f.authorize).not.toHaveBeenCalled(); expect(JSON.stringify(result)).not.toContain('current session');
    expect(f.host.conversationEvidence!().actions[0]?.action).toEqual({ kind: 'type_text', text: selected });
    f.host.close();
  });

  it('rejects invalid source ranges or control characters before native inspection', async () => {
    const f = fixture(undefined, capture('a👋b\u001b', 100));
    const { sourceId } = value(await f.call('capture_text'));
    const destinationObservationId = await f.destination();
    for (const [start, end] of [[99, 104], [100, 102], [102, 104], [103, 102], [100, 106], [100, 100]]) {
      expect(value(await f.call('transfer_text', { sourceId, start, end, destinationObservationId, x: 100, y: 100 })).code).toBe('invalid-text-range');
    }
    expect(value(await f.call('transfer_text', { sourceId, start: 100, end: 105, destinationObservationId, x: 100, y: 100 })).code).toBe('invalid-arguments');
    expect(f.input.inspect).not.toHaveBeenCalled(); expect(f.input.execute).not.toHaveBeenCalled(); f.host.close();
  });

  it.each(['unscoped', 'expired', 'unfocused', 'unsupported'] as const)('keeps the existing %s destination boundary', async (failure) => {
    const f = fixture(failure === 'unscoped' ? '' : undefined);
    const { sourceId } = value(await f.call('capture_text'));
    const destinationObservationId = await f.destination();
    if (failure === 'expired') vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 31_000);
    if (failure === 'unfocused') f.input.inspect.mockResolvedValue({ ...evidence, focused: false });
    if (failure === 'unsupported') f.input.inspect.mockResolvedValue({ ...evidence, role: 'AXTextField' });
    const result = value(await f.call('transfer_text', { sourceId, start: 0, end: capture().totalLength, destinationObservationId, x: 100, y: 100 }));
    expect(result.code).toBe({ unscoped: 'request-required', expired: 'stale-observation', unfocused: 'input-not-focused', unsupported: 'unsupported-text-target' }[failure]);
    expect(f.input.execute).not.toHaveBeenCalled(); f.host.close();
  });

  it('consumes observations and stops all input after an uncertain transfer, even after recapture', async () => {
    const f = fixture(); f.input.execute.mockResolvedValue({ status: 'uncertain', reason: 'text-value-mismatch' });
    const { sourceId } = value(await f.call('capture_text'));
    const args = { sourceId, start: 0, end: capture().totalLength, destinationObservationId: await f.destination(), x: 100, y: 100 };
    expect(value(await f.call('transfer_text', args))).toMatchObject({ status: 'uncertain', code: 'text-value-mismatch', inputStopped: true });
    args.destinationObservationId = await f.destination();
    expect(value(await f.call('transfer_text', args)).code).toBe('input-stopped');
    expect(value(await f.call('type_text', { observationId: args.destinationObservationId, x: 100, y: 100, text: 'retry' })).code).toBe('input-stopped');
    expect(f.input.execute).toHaveBeenCalledOnce(); f.host.close();
  });

  it('does not dispatch when cancellation arrives during destination verification', async () => {
    const f = fixture();
    const { sourceId } = value(await f.call('capture_text'));
    const destinationObservationId = await f.destination();
    const controller = new AbortController();
    f.input.inspect.mockImplementationOnce(async () => { controller.abort(); return evidence; });
    await expect(f.host.call('transfer_text', { sourceId, start: 0, end: 12, destinationObservationId, x: 100, y: 100 }, controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(f.input.execute).not.toHaveBeenCalled(); f.host.close();
  });
});
