import { afterEach, expect, it, vi } from 'vitest';
import { runVoice } from '../src/voice.js';
import type { DebugSession } from '../src/diagnostics.js';
import type { NativeVoiceEvent } from '../src/desktop/voice-types.js';

const mocks = vi.hoisted(() => ({ adapter: vi.fn(), start: vi.fn(), debug: vi.fn(), feedback: vi.fn(),
  context: { recent: vi.fn(() => []), observe: vi.fn(), close: vi.fn(async () => {}) } }));
vi.mock('../src/work-context.js', () => ({ workContextPath: () => '/fixture/work-context.json',
  openWorkContext: async () => mocks.context }));
vi.mock('../src/desktop/index.js', () => ({ desktopAdapter: mocks.adapter }));
vi.mock('../src/desktop/voice-process.js', () => ({ startVoiceHelper: mocks.start }));
vi.mock('../src/debug-session.js', () => ({ createDebugSession: mocks.debug }));
vi.mock('../src/desktop/feedback-process.js', async (original) => ({
  ...await original<typeof import('../src/desktop/feedback-process.js')>(), startFeedbackHelper: mocks.feedback,
}));
vi.mock('node:readline', () => ({ emitKeypressEvents: vi.fn() }));
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

it.each(['ctrl-c', 'abort'])('restores an initially idle terminal and closes the helper on %s', async (stopMethod) => {
  vi.stubEnv('OPENSAYSME_TEST_KEY', 'fixture-only');
  const controller = new AbortController();
  const pause = vi.fn(() => process.stdin);
  const resume = vi.fn(() => process.stdin);
  const rawMode = vi.fn(() => process.stdin);
  const replacement = { isTTY: true, isRaw: false, readableFlowing: null, pause, resume, setRawMode: rawMode };
  const originals = new Map(Object.keys(replacement).map((key) => [key, Object.getOwnPropertyDescriptor(process.stdin, key)]));
  for (const [key, value] of Object.entries(replacement)) Object.defineProperty(process.stdin, key, { configurable: true, value });
  const close = vi.fn(async () => {});
  mocks.adapter.mockResolvedValue({ voiceHelper: async () => ({ file: 'fixture', args: [] }), captureContext: vi.fn(), captureFrame: vi.fn() });
  mocks.start.mockImplementation((_spec: unknown, onEvent: (event: NativeVoiceEvent) => void) => {
    queueMicrotask(() => onEvent({ type: 'ready' }));
    return { ready: Promise.resolve(), done: new Promise(() => {}), send: vi.fn(), close };
  });
  try {
    await runVoice({ version: 1, shareVisualContext: true, reasoning: { provider: 'openai', model: 'gpt-5.4-mini', apiKeyEnv: 'OPENSAYSME_TEST_KEY' }, speech: { provider: 'openai', model: 'gpt-live-transcribe', apiKeyEnv: 'OPENSAYSME_TEST_KEY' } }, controller.signal, (event) => {
      if (event.type === 'state' && event.state === 'ready') {
        if (stopMethod === 'ctrl-c') process.stdin.emit('keypress', '\x03', { ctrl: true, name: 'c' });
        else controller.abort();
      }
    });
    expect(rawMode.mock.calls).toEqual([[true], [false]]);
    expect(pause).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(mocks.debug).not.toHaveBeenCalled();
    expect(mocks.context.close).toHaveBeenCalledOnce();
  } finally {
    for (const [key, original] of originals) {
      if (original) Object.defineProperty(process.stdin, key, original);
      else Reflect.deleteProperty(process.stdin, key);
    }
  }
});

function debugSession() {
  const debug: DebugSession = { directory: '/fixture/session', event: vi.fn(), input: vi.fn(), request: vi.fn(), result: vi.fn(),
    turnDirectory: (id) => `/fixture/session/turns/${id}`, close: vi.fn(async () => {}) };
  mocks.debug.mockResolvedValue(debug);
  return debug;
}
const config = { version: 1 as const, shareVisualContext: true as const,
  reasoning: { provider: 'openai' as const, model: 'gpt-5.4-mini', apiKeyEnv: 'OPENSAYSME_TEST_KEY' },
  speech: { provider: 'openai' as const, model: 'gpt-live-transcribe', apiKeyEnv: 'OPENSAYSME_TEST_KEY' } };

it('records startup, capabilities, helper cleanup and closes diagnostics without capturing while idle', async () => {
  vi.stubEnv('OPENSAYSME_TEST_KEY', 'fixture-only');
  const controller = new AbortController();
  const debug = debugSession();
  mocks.adapter.mockResolvedValue({ voiceHelper: async () => ({ file: 'fixture', args: [] }), captureContext: vi.fn(), captureFrame: vi.fn(),
    probe: async () => ({ platform: 'test', session: 'test', capabilities: Object.fromEntries(
      ['activeWindow', 'focusWindow', 'selectedText', 'globalHotkey', 'microphone', 'screenCapture'].map((name) => [name, { status: 'unverified', detail: 'private diagnostic detail' }])) }) });
  mocks.start.mockImplementation((_spec: unknown, onEvent: (event: NativeVoiceEvent) => void) => {
    queueMicrotask(() => onEvent({ type: 'ready' }));
    return { ready: Promise.resolve(), done: new Promise(() => {}), send: vi.fn(), close: vi.fn(async () => {}) };
  });
  const output = vi.fn((event) => { if (event.type === 'state' && event.state === 'ready') controller.abort(); });
  await runVoice(config, controller.signal, output, { debugDirectory: '/fixture/debug' });
  expect(mocks.debug).toHaveBeenCalledOnce();
  expect(debug.input).not.toHaveBeenCalled();
  expect(debug.request).not.toHaveBeenCalled();
  expect(debug.close).toHaveBeenCalledOnce();
  expect(output).toHaveBeenCalledWith({ type: 'debug', directory: '/fixture/session' });
  expect(debug.event).toHaveBeenCalledWith(expect.objectContaining({ event: 'configuration' }));
  expect(debug.event).toHaveBeenCalledWith(expect.objectContaining({ event: 'capability', data: { capability: 'microphone', status: 'unverified' } }));
  expect(debug.event).toHaveBeenCalledWith(expect.objectContaining({ event: 'helper-closed' }));
  expect(JSON.stringify(vi.mocked(debug.event).mock.calls)).not.toMatch(/fixture-only|private diagnostic detail/);
});

it('records missing provider configuration and closes diagnostics before any desktop access', async () => {
  vi.stubEnv('OPENSAYSME_TEST_KEY', '');
  const debug = debugSession();
  await expect(runVoice(config, new AbortController().signal, vi.fn(), { debugDirectory: '/fixture/debug' })).rejects.toThrow('Set OPENSAYSME_TEST_KEY');
  expect(mocks.debug).toHaveBeenCalledOnce();
  expect(debug.event).toHaveBeenCalledWith(expect.objectContaining({ event: 'failed' }));
  expect(debug.close).toHaveBeenCalledOnce();
  expect(mocks.start).not.toHaveBeenCalled();
  expect(mocks.adapter).not.toHaveBeenCalled();
});

it('keeps debug startup failures separate from voice configuration errors', async () => {
  vi.stubEnv('OPENSAYSME_TEST_KEY', '');
  mocks.debug.mockRejectedValue(new Error('private filesystem failure'));
  const emit = vi.fn();
  await expect(runVoice(config, new AbortController().signal, emit, { debugDirectory: '/fixture/debug' })).rejects.toThrow('Set OPENSAYSME_TEST_KEY');
  expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning' }));
  expect(JSON.stringify(emit.mock.calls)).not.toContain('private filesystem failure');
});

it('starts optional feedback, preserves terminal events, and closes the panel on stop', async () => {
  vi.stubEnv('OPENSAYSME_TEST_KEY', 'fixture-only');
  const controller = new AbortController();
  const sink = { send: vi.fn(), close: vi.fn(async () => {}) };
  mocks.feedback.mockReturnValue(sink);
  const captureContext = vi.fn(), captureFrame = vi.fn();
  const voiceHelper = vi.fn(async () => ({ file: 'fixture', args: ['--voice', 'Cmd+Space'] }));
  mocks.adapter.mockResolvedValue({ voiceHelper,
    feedbackHelper: async () => ({ file: 'fixture', args: ['--feedback'] }), captureContext, captureFrame });
  mocks.start.mockImplementation((_spec: unknown, onEvent: (event: NativeVoiceEvent) => void) => {
    queueMicrotask(() => onEvent({ type: 'ready' }));
    return { ready: Promise.resolve(), done: new Promise(() => {}), send: vi.fn(), close: vi.fn(async () => {}) };
  });
  const emit = vi.fn((event) => { if (event.type === 'state' && event.state === 'ready') setTimeout(() => controller.abort(), 0); });
  await runVoice({ ...config, activationHotkey: 'Cmd+Space' }, controller.signal, emit);
  expect(voiceHelper).toHaveBeenCalledWith('Cmd+Space');
  expect(mocks.start).toHaveBeenCalledWith({ file: 'fixture', args: ['--voice', 'Cmd+Space'] }, expect.any(Function));
  expect(mocks.feedback).toHaveBeenCalledWith({ file: 'fixture', args: ['--feedback'] }, expect.any(Function));
  expect(emit).toHaveBeenCalledWith({ type: 'state', state: 'ready' });
  expect(sink.send).toHaveBeenLastCalledWith({ type: 'hide' });
  expect(sink.close).toHaveBeenCalledOnce();
  expect(captureContext).not.toHaveBeenCalled(); expect(captureFrame).not.toHaveBeenCalled();
});

it('continues voice when feedback setup fails without exposing the native error', async () => {
  vi.stubEnv('OPENSAYSME_TEST_KEY', 'fixture-only');
  const controller = new AbortController();
  mocks.adapter.mockResolvedValue({ voiceHelper: async () => ({ file: 'fixture', args: [] }),
    feedbackHelper: async () => { throw new Error('private native data'); }, captureContext: vi.fn(), captureFrame: vi.fn() });
  mocks.start.mockImplementation((_spec: unknown, onEvent: (event: NativeVoiceEvent) => void) => {
    setTimeout(() => onEvent({ type: 'ready' }), 0);
    return { ready: Promise.resolve(), done: new Promise(() => {}), send: vi.fn(), close: vi.fn(async () => {}) };
  });
  const emit = vi.fn((event) => { if (event.type === 'state' && event.state === 'ready') controller.abort(); });
  await runVoice(config, controller.signal, emit);
  expect(emit).toHaveBeenCalledWith({ type: 'warning', message: expect.stringContaining('Voice continues in the terminal') });
  expect(JSON.stringify(emit.mock.calls)).not.toContain('private native data');
  expect(mocks.start).toHaveBeenCalledOnce(); expect(mocks.feedback).not.toHaveBeenCalled();
});

it('does not launch a late feedback helper after voice shutdown', async () => {
  vi.stubEnv('OPENSAYSME_TEST_KEY', 'fixture-only');
  const controller = new AbortController();
  let resolveFeedback!: (spec: { file: string; args: string[] }) => void;
  const feedbackSpec = new Promise<{ file: string; args: string[] }>((resolve) => { resolveFeedback = resolve; });
  mocks.adapter.mockResolvedValue({ voiceHelper: async () => ({ file: 'fixture', args: [] }),
    feedbackHelper: () => feedbackSpec, captureContext: vi.fn(), captureFrame: vi.fn() });
  mocks.start.mockImplementation((_spec: unknown, onEvent: (event: NativeVoiceEvent) => void) => {
    queueMicrotask(() => onEvent({ type: 'ready' }));
    return { ready: Promise.resolve(), done: new Promise(() => {}), send: vi.fn(), close: vi.fn(async () => {}) };
  });
  await runVoice(config, controller.signal, (event) => {
    if (event.type === 'state' && event.state === 'ready') {
      controller.abort(); resolveFeedback({ file: 'fixture', args: ['--feedback'] });
    }
  });
  expect(mocks.feedback).not.toHaveBeenCalled();
});

it('never waits for optional feedback setup when stopping voice', async () => {
  vi.stubEnv('OPENSAYSME_TEST_KEY', 'fixture-only');
  const controller = new AbortController();
  mocks.adapter.mockResolvedValue({ voiceHelper: async () => ({ file: 'fixture', args: [] }),
    feedbackHelper: () => new Promise(() => {}), captureContext: vi.fn(), captureFrame: vi.fn() });
  mocks.start.mockImplementation((_spec: unknown, onEvent: (event: NativeVoiceEvent) => void) => {
    queueMicrotask(() => onEvent({ type: 'ready' }));
    return { ready: Promise.resolve(), done: new Promise(() => {}), send: vi.fn(), close: vi.fn(async () => {}) };
  });
  await runVoice(config, controller.signal, (event) => {
    if (event.type === 'state' && event.state === 'ready') controller.abort();
  });
  expect(mocks.feedback).not.toHaveBeenCalled();
});
