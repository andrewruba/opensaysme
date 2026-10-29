import { afterEach, expect, it, vi } from 'vitest';
import { runVoice } from '../src/voice.js';
import type { NativeVoiceEvent } from '../src/desktop/voice-types.js';

const mocks = vi.hoisted(() => ({ adapter: vi.fn(), start: vi.fn() }));
vi.mock('../src/desktop/index.js', () => ({ desktopAdapter: mocks.adapter }));
vi.mock('../src/desktop/voice-process.js', () => ({ startVoiceHelper: mocks.start }));
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
  } finally {
    for (const [key, original] of originals) {
      if (original) Object.defineProperty(process.stdin, key, original);
      else Reflect.deleteProperty(process.stdin, key);
    }
  }
});
