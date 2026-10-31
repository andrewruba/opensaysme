import { afterEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import type { ReasoningFactory } from '../src/reasoning/types.js';
import type { DebugSession, DebugTurnInput, DebugTurnResult, DiagnosticEvent, PreparedReasoningRequest } from '../src/diagnostics.js';
import { VoiceRuntime, type VoiceOutput } from '../src/runtime.js';
import type { NativeVoiceCommand, DesktopContext } from '../src/desktop/voice-types.js';
import type { ScreenFrameCapture } from '../src/desktop/visual-types.js';
import type { TranscriptionOptions, TranscriptionSession } from '../src/speech/types.js';
import type { ToolHost } from '../src/tools/types.js';
import { conversationLifetimeMs, RecentConversation, type ConversationEvidence, type ConversationTurn } from '../src/conversation.js';
import type { VoiceRuntimeOptions } from '../src/runtime.js';
import { DesktopError, desktopMessages } from '../src/desktop/errors.js';
import { openWorkContext } from '../src/work-context.js';

const context: DesktopContext = { platform: 'test', capturedAt: '2026-10-28T00:00:00.000Z',
  activeWindow: { id: 'one', application: 'Editor' }, selectedText: 'original selection',
  pointer: { x: 12, y: 30, window: { id: 'two', application: 'Terminal' } }, warnings: [] };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function mockDebugSession() {
  const events: DiagnosticEvent[] = [];
  const inputs: Array<{ turnId: string; input: DebugTurnInput }> = [];
  const requests: Array<{ turnId: string; request: PreparedReasoningRequest }> = [];
  const results: Array<{ turnId: string; result: DebugTurnResult }> = [];
  const debug = {
    directory: '/debug/session',
    event: vi.fn<DebugSession['event']>((event) => { events.push(structuredClone(event)); }),
    input: vi.fn<DebugSession['input']>((turnId, input) => { inputs.push({ turnId, input: structuredClone(input) }); }),
    request: vi.fn<DebugSession['request']>((turnId, request) => { requests.push({ turnId, request: structuredClone(request) }); }),
    tool: vi.fn(),
    result: vi.fn<DebugSession['result']>((turnId, result) => { results.push({ turnId, result: structuredClone(result) }); }),
    turnDirectory: (turnId: string) => `/debug/session/turns/${turnId}`,
    close: vi.fn<DebugSession['close']>(() => new Promise(() => {})),
  } satisfies DebugSession;
  return { debug, events, inputs, requests, results };
}
const preparedRequest: PreparedReasoningRequest = {
  model: 'fixture-reasoning', instructions: 'Use the captured desktop context.', store: false, max_output_tokens: 100,
  input: [{ role: 'user', content: [{ type: 'input_text', text: 'What is this?' }] }],
};
const reason: ReasoningFactory = async () => 'Which window?';
const runtimes: VoiceRuntime[] = [];
afterEach(() => { for (const runtime of runtimes.splice(0)) runtime.close(); vi.useRealTimers(); });
function fixture(capture: (signal: AbortSignal) => Promise<DesktopContext> = async () => ({ ...structuredClone(context), capturedAt: new Date().toISOString() }),
  interpret: ReasoningFactory = reason, captureFrame: () => Promise<ScreenFrameCapture> = async () => { throw new Error('no screen'); },
  debug?: DebugSession, createTools?: VoiceRuntimeOptions['createTools'],
  work: Pick<VoiceRuntimeOptions, 'workContext' | 'observeWindow' | 'deadlines'> = {}) {
  let clock = 0;
  const commands: NativeVoiceCommand[] = [];
  const outputs: VoiceOutput[] = [];
  const sessions: Array<{ options: TranscriptionOptions; ready: ReturnType<typeof deferred<void>>;
    final: ReturnType<typeof deferred<string>>; audio: Buffer[]; commit: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>;
    updateKeywords: ReturnType<typeof vi.fn> }> = [];
  const runtime = new VoiceRuntime({
    input: { ready: Promise.resolve(), done: new Promise(() => {}), send: (command) => commands.push(command), close: async () => {} },
    apiKey: 'fixture-key', model: 'fixture-model', captureContext: capture,
    captureFrame, reason: interpret, debug, createTools, ...work,
    now: () => clock, emit: (output) => outputs.push(output),
    transcribe: (options): TranscriptionSession => {
      const ready = deferred<void>(); const final = deferred<string>();
      const audio: Buffer[] = []; const commit = vi.fn(); const close = vi.fn();
      const updateKeywords = vi.fn();
      sessions.push({ options, ready, final, audio, commit, close, updateKeywords });
      return { ready: ready.promise, finished: final.promise, append: (chunk) => audio.push(Buffer.from(chunk)), commit, close, updateKeywords };
    },
  });
  runtimes.push(runtime);
  return { runtime, commands, outputs, sessions, time: (value: number) => { clock = value; },
    id: () => { const command = commands.findLast((value) => value.type === 'start'); if (!command || !('turnId' in command)) throw new Error('no turn'); return command.turnId; } };
}
const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };

async function complete(f: ReturnType<typeof fixture>, transcript: string) {
  const index = f.sessions.length;
  f.runtime.toggle(); const id = f.id(); await flush();
  f.runtime.toggle(); f.runtime.handle({ type: 'audio-stopped', turnId: id });
  f.sessions[index]!.final.resolve(transcript); await flush();
  return id;
}

describe('recent work references', () => {
  it('observes only idle window metadata and shares names without carrying task authority', async () => {
    vi.useFakeTimers();
    const store = await openWorkContext();
    const observeWindow = vi.fn(async () => ({ platform: 'test',
      window: { id: 'private-native-id', application: 'Workspace', title: 'Maple — Review' }, selectedText: 'private selection' }));
    const capture = vi.fn(async () => ({ ...structuredClone(context), capturedAt: new Date().toISOString(),
      activeWindow: { id: 'other-id', application: 'Editor', title: 'Willow — Notes' } }));
    const captureFrame = vi.fn(async () => { throw new Error('no image'); });
    const reason = vi.fn<ReasoningFactory>(async () => 'Inspected the requested work.');
    const f = fixture(capture, reason, captureFrame, undefined, undefined, { workContext: store, observeWindow });
    f.runtime.handle({ type: 'ready' }); await flush();
    expect(observeWindow).toHaveBeenCalledOnce();
    expect(capture).not.toHaveBeenCalled(); expect(captureFrame).not.toHaveBeenCalled();
    expect(store.recent()[0]).toEqual({ application: 'Workspace', title: 'Maple — Review', observedAt: new Date().toISOString() });
    f.runtime.toggle(); await flush();
    expect(f.sessions[0]!.options.keywords).toEqual(['Workspace', 'Maple', 'Review']);
    expect(f.sessions[0]!.updateKeywords).toHaveBeenCalledWith(['Editor', 'Willow', 'Notes', 'Workspace', 'Maple', 'Review']);
    await vi.advanceTimersByTimeAsync(3000);
    expect(observeWindow).toHaveBeenCalledOnce();
    f.runtime.cancel(); f.runtime.handle({ type: 'audio-stopped', turnId: f.id() });
    expect(store.recent()).toHaveLength(2);
    await complete(f, 'Find the Maple work.');
    const input = reason.mock.calls[0]![0];
    expect(input.conversation).toEqual([]);
    expect(input.workContext).toEqual(store.recent());
    expect(JSON.stringify(input.workContext)).not.toMatch(/private|other-id|original selection|request|action/);
    f.runtime.close();
    await vi.advanceTimersByTimeAsync(6000);
    expect(observeWindow).toHaveBeenCalledOnce();
    await store.close();
  });

  it('discards an idle observation arriving after activation and cancels collection on close', async () => {
    vi.useFakeTimers();
    const store = await openWorkContext();
    const pending = deferred<{ platform: string; window: { id: string; application: string; title: string } }>();
    const observeWindow = vi.fn<NonNullable<VoiceRuntimeOptions['observeWindow']>>(() => pending.promise);
    const capture = deferred<DesktopContext>();
    const f = fixture(() => capture.promise, reason, undefined, undefined, undefined, { workContext: store, observeWindow });
    f.runtime.handle({ type: 'ready' });
    f.runtime.toggle();
    expect(observeWindow.mock.calls[0]![0].aborted).toBe(true);
    pending.resolve({ platform: 'test', window: { id: 'stale', application: 'Wrong', title: 'Old work' } }); await flush();
    expect(store.recent()).toEqual([]);
    f.runtime.close();
    capture.resolve({ ...structuredClone(context), capturedAt: new Date().toISOString() }); await flush();
    await vi.advanceTimersByTimeAsync(6000);
    expect(store.recent()).toEqual([]);
    expect(f.sessions[0]!.updateKeywords).not.toHaveBeenCalled();
    expect(observeWindow).toHaveBeenCalledOnce();
    await store.close();
  });
});

it('surfaces deduplicated desktop recovery warnings without stopping the request', async () => {
  const host: ToolHost = { list: () => [], call: vi.fn(), close: vi.fn() };
  const f = fixture(async () => ({ ...structuredClone(context), capturedAt: new Date().toISOString(), issues: ['permission-required'] }),
    async (input) => {
      for (let i = 0; i < 2; i++) input.onTool?.({ callId: String(i), name: 'capture_screen', arguments: {}, phase: 'completed', effect: 'read',
        result: { isError: true, desktopIssue: 'screen-permission-required', content: [{ type: 'text', text: '{}' }] } });
      return 'Desktop context was incomplete.';
    }, async () => { throw new DesktopError('screen-permission-required'); }, undefined, () => host);
  const id = await complete(f, 'Explain this');
  expect(f.outputs.filter((event) => event.type === 'warning' && event.desktopIssue === 'screen-permission-required'))
    .toEqual([{ type: 'warning', turnId: id, desktopIssue: 'screen-permission-required', message: desktopMessages['screen-permission-required'] }]);
  expect(f.outputs).toContainEqual({ type: 'warning', turnId: id, desktopIssue: 'permission-required', message: desktopMessages['permission-required'] });
  expect(f.outputs).toContainEqual(expect.objectContaining({ type: 'result', turnId: id, response: 'Desktop context was incomplete.' }));
});

it('reports explicit microphone denial separately from an unavailable device', async () => {
  const f = fixture(); f.runtime.toggle(); const id = f.id();
  f.runtime.handle({ type: 'error', turnId: id, code: 'microphone-permission-required' });
  expect(f.outputs).toContainEqual({ type: 'error', turnId: id, message: desktopMessages['microphone-permission-required'] });
  expect(f.commands.at(-1)).toEqual({ type: 'cancel', turnId: id });
});

describe('conversational follow-up lifecycle', () => {
  it('carries clarification context to the actor and a fresh tool scope without sharing mutable history', async () => {
    const actor: ConversationTurn[][] = [];
    const scopes: ConversationTurn[][] = [];
    const createTools = vi.fn<NonNullable<VoiceRuntimeOptions['createTools']>>((_request, _reference, conversation) => {
      scopes.push(structuredClone(conversation));
      if (conversation[0]) conversation[0].request = 'Changed by tool factory';
      return { list: () => [], call: vi.fn(), close: vi.fn() };
    });
    const f = fixture(undefined, async (input) => {
      actor.push(structuredClone(input.conversation ?? []));
      return input.transcript === 'Fill this form' ? 'Which project, Aster or Birch?' : 'I found the Aster form.';
    }, undefined, undefined, createTools);
    const first = await complete(f, 'Fill this form');
    await complete(f, 'The Aster one');
    expect(actor).toMatchObject([[], [{ id: first, request: 'Fill this form', response: 'Which project, Aster or Birch?',
      referenceContext: [{ context: { activeWindow: context.activeWindow } }], evidence: { windows: [], actions: [] } }]]);
    expect(scopes).toEqual(actor);
    expect(createTools).toHaveBeenCalledTimes(2);
    expect(createTools.mock.calls[1]![0]).toBe('The Aster one');
    expect(actor[1]![0]).not.toHaveProperty('history');
    expect(actor[1]![0]).not.toHaveProperty('visual');
    await complete(f, 'What did I ask?');
    expect(actor[2]![0]!.request).toBe('Fill this form');
  });

  it('keeps native outcome evidence independently of host cleanup and assistant success claims', async () => {
    const evidence: ConversationEvidence = { windows: [], actions: [{
      window: { id: 'native-form', application: 'Browser', title: 'Aster' }, capturedAt: new Date().toISOString(),
      action: { kind: 'click' }, target: { role: 'AXButton', title: 'Submit', description: '', value: '',
        bounds: { x: 100, y: 200, width: 100, height: 30 }, focused: false, editable: false },
      point: { x: 110, y: 210 }, effect: 'submit', status: 'uncertain',
    }] };
    const actor: ConversationTurn[][] = [];
    const f = fixture(undefined, async (input) => {
      actor.push(structuredClone(input.conversation ?? []));
      return 'Submitted successfully.';
    }, undefined, undefined, () => ({ list: () => [], call: vi.fn(),
      conversationEvidence: () => evidence, close: () => { evidence.actions.length = 0; } }));
    await complete(f, 'Fill this form and submit it');
    expect(evidence.actions).toEqual([]);
    await complete(f, 'Did that work?');
    expect(actor[1]![0]).toMatchObject({ response: 'Submitted successfully.', evidence: { actions: [{
      window: { id: 'native-form' }, action: { kind: 'click' }, effect: 'submit', status: 'uncertain',
    }] } });
    expect(JSON.stringify(actor[1])).not.toMatch(/observationId|fingerprint|permission/);
  });

  it.each(['expiry', 'idle terminal Escape', 'failed turn', 'cancelled turn'] as const)('clears prior context after %s', async (reason) => {
    const actor: ConversationTurn[][] = [];
    const f = fixture(undefined, async (input) => {
      actor.push(structuredClone(input.conversation ?? []));
      return 'Ready for a follow-up.';
    });
    await complete(f, 'Fill this form');
    if (reason === 'expiry') f.time(conversationLifetimeMs);
    else if (reason === 'idle terminal Escape') f.runtime.cancel();
    else {
      f.runtime.toggle(); const id = f.id(); await flush();
      if (reason === 'failed turn') {
        f.sessions[1]!.final.reject(new Error('Speech failed.')); await flush();
      } else f.runtime.cancel();
      f.runtime.handle({ type: 'audio-stopped', turnId: id });
      f.sessions[1]!.final.resolve('Late request'); await flush();
    }
    await complete(f, 'Now submit it');
    expect(actor.at(-1)).toEqual([]);
  });

  it('drops an oversized turn completely instead of retaining an older target or truncating constraints', async () => {
    const actor: ConversationTurn[][] = [];
    const f = fixture(undefined, async (input) => {
      actor.push(structuredClone(input.conversation ?? []));
      return 'Done.';
    });
    await complete(f, 'Point to the Aster form');
    await complete(f, `${'a'.repeat(65_500)} Do not submit it.`);
    expect(f.outputs).toContainEqual(expect.objectContaining({ type: 'warning',
      message: 'Recent conversation context could not be retained. Include the target in your next request.' }));
    await complete(f, 'Now click it');
    expect(actor.at(-1)).toEqual([]);
  });

  it('clears retained context and its expiry timer when the runtime closes while idle', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await complete(f, 'Fill this form');
    expect(vi.getTimerCount()).toBe(1); // Only bounded conversation retention remains.
    const clear = vi.spyOn(RecentConversation.prototype, 'clear');
    try {
      f.runtime.close();
      expect(clear).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
      f.runtime.toggle();
      expect(f.sessions).toHaveLength(1);
    } finally { clear.mockRestore(); }
  });
});

describe('live voice turn lifecycle', () => {
  it('publishes bounded tool summaries by default and includes them in the final result without tool contents', async () => {
    const host: ToolHost = { list: () => [{ name: 'capture_screen', description: 'Capture', effect: 'read', inputSchema: {} }], call: vi.fn(), close: vi.fn() };
    const f = fixture(undefined, async (input) => {
      for (let index = 0; index < 30; index++) input.onTool!({ callId: `private-${index}`, name: 'capture_screen',
        arguments: { private: 'private arguments' }, effect: 'read', phase: 'completed',
        result: { desktopIssue: 'accessibility-unavailable', content: [{ type: 'text', text: '{"value":"private captured value"}' }] } });
      return 'Keyboard inspection was unavailable.';
    }, undefined, undefined, () => host);
    const turnId = await complete(f, 'Open the requested site');
    const summaries = f.outputs.filter((event) => event.type === 'tool-summary');
    expect(summaries).toHaveLength(24);
    expect(summaries[0]).toEqual({ type: 'tool-summary', turnId, summary: { name: 'capture_screen', effect: 'read', outcome: 'partial', desktopIssue: 'accessibility-unavailable' } });
    const result = f.outputs.find((event) => event.type === 'result');
    expect(result?.toolResults).toEqual(summaries.map((event) => event.summary));
    expect(JSON.stringify(result)).not.toContain('private');
    expect(JSON.stringify(summaries)).not.toContain('private');
  });

  it('publishes source-backed activity only when a focus or input tool starts', async () => {
    const target = { application: 'Editor', title: 'Aster agent' };
    const feedbackTarget = vi.fn<NonNullable<ToolHost['feedbackTarget']>>((name) => name === 'focus_window' ? target : undefined);
    const host: ToolHost = { list: () => [], call: vi.fn(), feedbackTarget, close: vi.fn() };
    const f = fixture(undefined, async (input) => {
      input.onTool!({ callId: 'read', name: 'list_windows', arguments: {}, effect: 'read', phase: 'started' });
      input.onTool!({ callId: 'focus', name: 'focus_window', arguments: { windowId: 'window-2' }, effect: 'focus', phase: 'started' });
      input.onTool!({ callId: 'focus', name: 'focus_window', arguments: { windowId: 'window-2' }, effect: 'focus', phase: 'completed' });
      input.onTool!({ callId: 'input', name: 'click', arguments: { observationId: 'unknown', application: 'Forged' }, effect: 'input', phase: 'started' });
      return 'Target needs fresh evidence.';
    }, undefined, undefined, () => host);
    const turnId = await complete(f, 'Switch to the agent');
    expect(f.outputs.filter((event) => event.type === 'activity')).toEqual([
      { type: 'activity', turnId, name: 'focus_window', target },
      { type: 'activity', turnId, name: 'click' },
    ]);
    expect(feedbackTarget).toHaveBeenCalledTimes(2);
    expect(host.call).not.toHaveBeenCalled();
    for (const [index, output] of f.outputs.entries()) {
      if (output.type === 'activity') expect(f.outputs[index - 1]).toEqual({ type: 'state', state: 'acting', turnId });
    }
  });

  it('dismisses feedback on idle cancellation without starting native work', () => {
    const f = fixture();
    f.runtime.cancel();
    expect(f.outputs).toEqual([{ type: 'dismiss-feedback' }]);
    expect(f.commands).toEqual([]);
    f.runtime.close(); f.runtime.cancel();
    expect(f.outputs).toHaveLength(1);
  });

  it('uses a fresh tool session for each turn, exposes progress, and records multiple requests', async () => {
    const d = mockDebugSession();
    const hosts: Array<ToolHost & { close: ReturnType<typeof vi.fn> }> = [];
    const createTools = vi.fn(() => {
      const host = { list: () => [], call: vi.fn<ToolHost['call']>(async () => ({ content: [{ type: 'text', text: 'Verified.' }] })), close: vi.fn() };
      hosts.push(host); return host;
    });
    const interpret: ReasoningFactory = async (input) => {
      input.onRequest?.(preparedRequest, 1);
      const event = { callId: 'call-1', name: 'focus_window', arguments: { windowId: 'window-2' }, effect: 'focus' as const };
      input.onTool?.({ ...event, phase: 'started' });
      const result = await input.tools!.call(event.name, event.arguments, input.signal);
      input.onTool?.({ ...event, phase: 'completed', result, durationMs: 12 });
      input.onRequest?.(preparedRequest, 2);
      return 'Switched to the frontend.';
    };
    const f = fixture(undefined, interpret, undefined, d.debug, createTools);
    expect(createTools).not.toHaveBeenCalled();
    for (let index = 0; index < 2; index++) {
      f.runtime.toggle(); const id = f.id(); await flush();
      f.runtime.toggle(); f.runtime.handle({ type: 'audio-stopped', turnId: id });
      f.sessions[index]!.final.resolve('Switch to the frontend'); await flush();
      expect(hosts[index]!.close).toHaveBeenCalled();
      expect(f.outputs.findLast((event) => event.type === 'result')).toMatchObject({ response: 'Switched to the frontend.',
        latency: { toolCalls: 1, toolMs: 12 } });
    }
    expect(createTools).toHaveBeenCalledTimes(2);
    expect(createTools).toHaveBeenNthCalledWith(1, 'Switch to the frontend', expect.any(Array), []);
    expect(createTools).toHaveBeenNthCalledWith(2, 'Switch to the frontend', expect.any(Array),
      [expect.objectContaining({ request: 'Switch to the frontend', response: 'Switched to the frontend.' })]);
    expect(hosts[0]).not.toBe(hosts[1]);
    expect(f.outputs).toContainEqual(expect.objectContaining({ type: 'state', state: 'acting' }));
    expect(d.debug.request.mock.calls.map((call) => call[2])).toEqual([1, 2, 1, 2]);
    expect(d.debug.tool).toHaveBeenCalledTimes(4);
  });

  it('closes the tool session on cancellation and ignores late tool feedback and answers', async () => {
    const d = mockDebugSession(); const result = deferred<string>();
    const host: ToolHost = { list: () => [{ name: 'focus_window', description: 'Focus', effect: 'focus', inputSchema: {} }], call: vi.fn(), close: vi.fn() };
    let request: Parameters<ReasoningFactory>[0] | undefined;
    const f = fixture(undefined, async (input) => { request = input; return result.promise; }, undefined, d.debug, () => host);
    f.runtime.toggle(); const id = f.id(); await flush();
    f.runtime.toggle(); f.runtime.handle({ type: 'audio-stopped', turnId: id });
    f.sessions[0]!.final.resolve('Switch to the frontend'); await flush();
    expect(request?.tools).toBe(host);
    f.runtime.cancel(); f.runtime.handle({ type: 'audio-stopped', turnId: id });
    expect(request?.signal.aborted).toBe(true);
    expect(host.close).toHaveBeenCalled();
    request?.onTool?.({ callId: 'late', name: 'focus_window', arguments: {}, effect: 'focus', phase: 'started' });
    request?.onTool?.({ callId: 'late', name: 'focus_window', arguments: {}, effect: 'focus', phase: 'completed' });
    result.resolve('Late success'); await flush();
    expect(d.debug.tool).not.toHaveBeenCalled();
    expect(f.outputs.some((event) => event.type === 'result')).toBe(false);
    expect(f.outputs.some((event) => event.type === 'activity')).toBe(false);
    expect(f.outputs.some((event) => event.type === 'tool-summary')).toBe(false);
    expect(f.outputs.at(-1)).toMatchObject({ type: 'state', state: 'ready' });
  });

  it('leaves diagnostic callbacks and bundle paths absent by default', async () => {
    const interpret = vi.fn<ReasoningFactory>(async () => 'The answer.');
    const f = fixture(undefined, interpret);
    f.runtime.toggle(); const id = f.id(); await flush();
    f.runtime.toggle(); f.runtime.handle({ type: 'audio-stopped', turnId: id });
    f.sessions[0]!.final.resolve('What is this?'); await flush();
    expect(f.sessions[0]!.options.onDiagnostic).toBeUndefined();
    expect(interpret.mock.calls[0]![0].onRequest).toBeUndefined();
    expect(interpret.mock.calls[0]![0].onDiagnostic).toBeUndefined();
    expect(f.outputs.find((output) => output.type === 'result')).not.toHaveProperty('debugDirectory');
    expect(f.outputs.some((output) => output.type === 'debug')).toBe(false);
  });

  it('records context, prepared request, and response without awaiting diagnostic disk work', async () => {
    const d = mockDebugSession(); const response = deferred<string>();
    const interpret = vi.fn<ReasoningFactory>((input) => {
      input.onRequest?.(preparedRequest);
      input.onDiagnostic?.({ component: 'reasoning', event: 'request-started' });
      return response.promise;
    });
    const f = fixture(undefined, interpret, undefined, d.debug);
    f.runtime.toggle(); const id = f.id(); await flush();
    f.time(20); f.runtime.handle({ type: 'audio-started', turnId: id });
    const audio = Buffer.alloc(4800, 7).toString('base64');
    f.time(30); f.runtime.handle({ type: 'audio', turnId: id, capturedAt: new Date().toISOString(),
      startSample: 0, timing: 'estimated', data: audio });
    f.time(100); f.runtime.toggle(); f.runtime.handle({ type: 'audio-stopped', turnId: id });
    f.time(170); f.sessions[0]!.final.resolve('What is this?'); await flush();
    expect(interpret).toHaveBeenCalledOnce();
    expect(d.inputs).toMatchObject([{ turnId: id, input: { transcript: 'What is this?',
      history: { contexts: [{ context: { selectedText: 'original selection' } }], audio: { samples: 2400 } }, visual: { frames: [] } } }]);
    expect(d.requests).toEqual([{ turnId: id, request: preparedRequest }]);
    expect(d.events).toContainEqual({ component: 'desktop', event: 'first-audio', turnId: id, data: { startSample: 0, timing: 'estimated' } });
    expect(d.events).toContainEqual({ component: 'reasoning', event: 'request-started', turnId: id, data: undefined });
    expect(JSON.stringify(d.events)).not.toContain(audio);
    expect(JSON.stringify(d.inputs)).not.toContain(audio);
    f.time(200); response.resolve('The answer.'); await flush();
    const result = f.outputs.find((output) => output.type === 'result');
    expect(result).toMatchObject({ response: 'The answer.', debugDirectory: d.debug.turnDirectory(id),
      latency: { reasoningMs: 30, stopToResponseMs: 100, stopToResultMs: 100 } });
    expect(d.results).toEqual([{ turnId: id, result: { status: 'completed', response: 'The answer.',
      latency: result?.type === 'result' ? result.latency : undefined } }]);
    expect(d.debug.close).not.toHaveBeenCalled();
    expect(f.outputs.at(-1)).toMatchObject({ type: 'state', state: 'ready' });
    // Queued diagnostics keep their snapshot after normal turn cleanup empties the live history.
    expect(d.inputs[0]!.input.history.contexts).toHaveLength(1);
    expect(interpret.mock.calls[0]![0].history.contexts).toEqual([]);
  });

  it('snapshots partial context and cancellation before model-input preparation', async () => {
    const d = mockDebugSession(); const f = fixture(undefined, undefined, undefined, d.debug);
    f.runtime.toggle(); const id = f.id(); await flush();
    f.sessions[0]!.options.onPartial('unfinished request');
    f.runtime.cancel(); f.runtime.handle({ type: 'audio-stopped', turnId: id });
    f.sessions[0]!.final.resolve('late final transcript'); await flush();
    expect(d.inputs).toMatchObject([{ turnId: id, input: { transcript: 'unfinished request',
      history: { contexts: [{ context: { selectedText: 'original selection' } }] }, visual: undefined } }]);
    expect(d.requests).toEqual([]);
    expect(d.results).toMatchObject([{ turnId: id, result: { status: 'cancelled' } }]);
    expect(f.outputs.some((output) => output.type === 'result')).toBe(false);
    expect(f.outputs.at(-1)).toMatchObject({ type: 'state', state: 'ready' });
  });

  it('retains prepared inputs and records a failed reasoning turn', async () => {
    const d = mockDebugSession();
    const f = fixture(undefined, async (input) => { input.onRequest?.(preparedRequest); throw new Error('Reasoning provider unavailable.'); }, undefined, d.debug);
    f.runtime.toggle(); const id = f.id(); await flush();
    f.runtime.toggle(); f.runtime.handle({ type: 'audio-stopped', turnId: id });
    f.sessions[0]!.final.resolve('What is this?'); await flush();
    f.runtime.handle({ type: 'audio-stopped', turnId: id });
    expect(d.inputs).toHaveLength(1);
    expect(d.inputs[0]!.input.transcript).toBe('What is this?');
    expect(d.inputs[0]!.input.history.contexts).toHaveLength(1);
    expect(d.requests).toEqual([{ turnId: id, request: preparedRequest }]);
    expect(d.results).toMatchObject([{ turnId: id, result: { status: 'failed', error: { message: 'Reasoning provider unavailable.' } } }]);
    expect(f.outputs.some((output) => output.type === 'result')).toBe(false);
    expect(f.outputs.at(-1)).toMatchObject({ type: 'state', state: 'ready' });
  });

  it('records an interrupted active turn on close and ignores later speech events', async () => {
    const d = mockDebugSession(); const f = fixture(undefined, undefined, undefined, d.debug);
    f.runtime.toggle(); const id = f.id(); await flush();
    f.sessions[0]!.options.onPartial('unfinished request');
    f.runtime.close();
    f.sessions[0]!.options.onPartial('late text');
    f.sessions[0]!.final.resolve('late final'); await flush();
    expect(d.inputs).toMatchObject([{ turnId: id, input: { transcript: 'unfinished request' } }]);
    expect(d.results).toMatchObject([{ turnId: id, result: { status: 'interrupted' } }]);
    expect(d.events.filter((event) => event.event === 'turn-interrupted')).toHaveLength(1);
    expect(d.debug.close).not.toHaveBeenCalled(); // runVoice owns the bounded session flush.
    expect(f.outputs.some((output) => output.type === 'result')).toBe(false);
  });

  it('pairs a complete phrase with full-frame trails, publishes text and metadata, and releases images', async () => {
    const d = mockDebugSession();
    const data = (await sharp({ create: { width: 100, height: 100, channels: 3, background: 'white' } }).jpeg().toBuffer()).toString('base64');
    const epoch = Date.parse('2026-10-28T12:00:00Z');
    vi.useFakeTimers({ now: epoch });
    let request: Parameters<ReasoningFactory>[0] | undefined;
    let received: Parameters<ReasoningFactory>[0]['visual'] | undefined;
    const f = fixture(undefined, async (input) => {
      request = input;
      received = structuredClone(input.visual);
      expect(input.history.frames[0]?.image.data).toBe(data);
      return 'The number is 42.';
    }, async () => ({ capturedAt: new Date().toISOString(), display: { id: 'display', bounds: { x: 0, y: 0, width: 200, height: 200 } },
      image: { mimeType: 'image/jpeg', width: 100, height: 100, data }, warnings: [] }), d.debug);
    f.runtime.toggle(); const id = f.id(); await flush();
    f.runtime.handle({ type: 'audio-started', turnId: id });
    for (const atMs of [100, 200]) {
      f.time(atMs);
      f.runtime.handle({ type: 'pointer', turnId: id, capturedAt: new Date(epoch + atMs).toISOString(), x: atMs / 2, y: 80, displayId: 'display' });
    }
    f.time(300); f.runtime.handle({ type: 'audio', turnId: id, capturedAt: new Date(epoch + 100).toISOString(),
      startSample: 0, timing: 'device', data: Buffer.alloc(4800).toString('base64') });
    f.time(600); f.runtime.toggle(); f.runtime.handle({ type: 'audio-stopped', turnId: id });
    // The final phrase arrives after capture stops and still joins the correct frame.
    f.time(620); f.sessions[0]!.options.onPhrase({ id: 'p1', text: 'What number is this?', startSample: 0, endSample: 2400, boundary: 'stop' });
    f.sessions[0]!.final.resolve('What number is this?');
    await vi.waitFor(() => expect(f.outputs.some((output) => output.type === 'result')).toBe(true));
    const result = f.outputs.find((output) => output.type === 'result');
    expect(result).toMatchObject({ response: 'The number is 42.', visualContext: { frames: [{ frameId: 'f1', phraseIds: ['p1'],
      trailImageIncluded: true, trails: [{ points: [{ x: 0.25, y: 0.4, atMs: 100 }, { x: 0.5, y: 0.4, atMs: 200 }] }] }] } });
    expect(received?.frames[0]?.image).toMatchObject({ width: 100, height: 100 });
    expect(JSON.stringify(result)).not.toContain(data);
    expect(JSON.stringify(result)).not.toContain(received?.frames[0]?.image?.data);
    expect(request?.visual.frames).toEqual([]);
    expect(request?.history.frames).toEqual([]);
    expect(d.inputs[0]!.input.history.frames[0]!.image.data).toBe(data);
    expect(d.inputs[0]!.input.visual).toEqual(received);
    expect(d.results).toMatchObject([{ result: { status: 'completed', response: 'The number is 42.' } }]);
  });

  it('starts only on activation, streams before stop, and measures the full turn', async () => {
    const f = fixture();
    expect(f.sessions).toHaveLength(0);
    f.runtime.toggle(); const id = f.id();
    await flush();
    f.time(20); f.runtime.handle({ type: 'audio-started', turnId: id });
    f.time(30); f.runtime.handle({ type: 'audio', turnId: id, capturedAt: new Date().toISOString(),
      startSample: 0, timing: 'estimated', data: Buffer.alloc(4800, 1).toString('base64') });
    f.time(40); f.sessions[0]!.ready.resolve(); await flush();
    f.time(50); f.sessions[0]!.options.onPartial('');
    f.time(60); f.sessions[0]!.options.onPartial('hello');
    expect(f.sessions[0]!.audio[0]![0]).toBe(1);
    expect(f.outputs).toContainEqual({ type: 'partial', turnId: id, text: 'hello' });
    f.time(100); f.runtime.toggle();
    expect(f.sessions[0]!.commit).not.toHaveBeenCalled();
    f.runtime.handle({ type: 'audio-stopped', turnId: id });
    expect(f.sessions[0]!.commit).toHaveBeenCalledOnce();
    f.time(160); f.sessions[0]!.final.resolve('hello world'); await flush();
    const result = f.outputs.find((output) => output.type === 'result');
    expect(result).toMatchObject({ type: 'result', turnId: id, transcript: 'hello world',
      response: 'Which window?',
      attention: { contexts: [{ context: { selectedText: 'original selection' } }],
        audio: { firstReceivedAtMs: 30, durationMs: 100, samples: 2400 } },
      latency: { activationToListeningMs: 20, activationToFirstAudioMs: 30, activationToProviderReadyMs: 40,
        activationToFirstTranscriptMs: 60, stopToFinalTranscriptMs: 60, stopToResultMs: 60,
        contextCaptureMs: 0, visualPreparationMs: 0, reasoningMs: 0, stopToResponseMs: 60, recordingMs: 100, totalMs: 160 } });
    expect(f.commands.at(-1)).toEqual({ type: 'settled', turnId: id });
    expect(f.outputs.at(-1)).toEqual({ type: 'state', state: 'ready' });
    f.runtime.toggle(); expect(f.sessions).toHaveLength(2);
  });

  it('starts audio despite slow context and freezes it at stop without delaying the response', async () => {
    vi.useFakeTimers();
    const f = fixture(() => new Promise(() => {}));
    f.runtime.toggle(); const id = f.id();
    expect(f.commands[0]).toEqual({ type: 'start', turnId: id });
    f.runtime.handle({ type: 'audio-started', turnId: id });
    f.runtime.toggle(); f.runtime.handle({ type: 'audio-stopped', turnId: id });
    f.sessions[0]!.final.resolve('speech still works');
    await flush();
    expect(f.outputs).toContainEqual({ type: 'transcript', turnId: id, text: 'speech still works' });
    await flush();
    const result = f.outputs.find((output) => output.type === 'result');
    expect(result?.type === 'result' && result.attention.warnings).toContain('No window/selection context was captured for this turn.');
  });

  it('waits for cleanup acknowledgment and ignores late events from cancelled turns', async () => {
    const f = fixture(); f.runtime.toggle(); const old = f.id();
    f.runtime.cancel(); f.runtime.toggle();
    expect(f.sessions).toHaveLength(1);
    expect(f.sessions[0]!.options.signal.aborted).toBe(true);
    f.runtime.handle({ type: 'audio-stopped', turnId: old });
    f.runtime.toggle(); const current = f.id();
    expect(current).not.toBe(old);
    f.sessions[0]!.options.onPartial('stale');
    f.sessions[0]!.options.onPhrase({ id: 'stale', text: 'stale', startSample: 0, endSample: 1, boundary: 'stop' });
    f.sessions[0]!.final.resolve('stale');
    f.runtime.handle({ type: 'audio', turnId: old, data: 'AAA=', capturedAt: new Date().toISOString(), startSample: 0, timing: 'device' });
    f.runtime.handle({ type: 'audio-stopped', turnId: old }); await flush();
    expect(f.sessions[1]!.audio).toHaveLength(0);
    expect(f.outputs.filter((output) => output.type === 'result' || output.type === 'partial')).toEqual([]);
  });

  it('recovers from a provider failure without restarting the helper', async () => {
    const f = fixture(); f.runtime.toggle(); const id = f.id();
    f.sessions[0]!.final.reject(new Error('Speech connection failed.')); await flush();
    expect(f.commands.at(-1)).toEqual({ type: 'cancel', turnId: id });
    f.runtime.handle({ type: 'audio-stopped', turnId: id });
    f.runtime.toggle(); expect(f.sessions).toHaveLength(2);
  });

  it('prepares timed phrases while listening and carries their capture intervals into the response', async () => {
    const epoch = Date.parse('2026-10-28T12:00:00Z');
    vi.useFakeTimers({ now: epoch });
    const f = fixture(); f.runtime.toggle(); const id = f.id(); await flush();
    f.time(50); f.runtime.handle({ type: 'audio-started', turnId: id });
    f.time(300); f.runtime.handle({ type: 'audio', turnId: id, capturedAt: new Date(epoch + 100).toISOString(),
      startSample: 0, timing: 'device', data: Buffer.alloc(4800).toString('base64') });
    f.time(500); f.sessions[0]!.options.onPhrase({ id: 'p1', text: 'use this', startSample: 0, endSample: 2400, boundary: 'pause' });
    f.sessions[0]!.options.onPartial('use this');
    expect(f.outputs.some((output) => output.type === 'result')).toBe(false);
    expect(f.outputs.filter((output) => output.type === 'state').at(-1)).toMatchObject({ state: 'listening' });
    f.time(600); f.runtime.toggle();
    f.runtime.handle({ type: 'audio-stopped', turnId: id });
    f.time(620); f.sessions[0]!.final.resolve('use this'); await flush();
    expect(f.outputs.find((output) => output.type === 'result')).toMatchObject({
      attention: { transcript: [{ text: 'use this', startMs: 100, endMs: 200, receivedAtMs: 500, timing: 'device' }] },
      latency: { activationToFirstPhraseMs: 500, maxPhraseFinalizationMs: 300, maxAudioDeliveryLagMs: 100, stopToFinalTranscriptMs: 20 },
    });
  });

  it('replaces partial text rather than concatenating corrections and rejects mismatched audio offsets', () => {
    const f = fixture(); f.runtime.toggle(); const id = f.id();
    f.sessions[0]!.options.onPartial('use that');
    f.sessions[0]!.options.onPartial('use this here');
    expect(f.outputs.at(-1)).toMatchObject({ type: 'partial', text: 'use this here' });
    f.runtime.handle({ type: 'audio', turnId: id, capturedAt: new Date().toISOString(),
      startSample: 2400, timing: 'device', data: Buffer.alloc(4800).toString('base64') });
    expect(f.sessions[0]!.audio).toEqual([]);
    expect(f.commands.at(-1)).toEqual({ type: 'cancel', turnId: id });
  });

  it('accepts Escape while processing and never publishes the abandoned result', async () => {
    const f = fixture(); f.runtime.toggle(); const id = f.id();
    f.runtime.toggle(); f.runtime.handle({ type: 'audio-stopped', turnId: id });
    f.runtime.handle({ type: 'cancel' });
    f.sessions[0]!.final.resolve('discard me'); await flush();
    f.runtime.handle({ type: 'audio-stopped', turnId: id });
    expect(f.outputs.some((output) => output.type === 'result')).toBe(false);
    expect(f.outputs.at(-1)).toEqual({ type: 'state', state: 'ready' });
  });

  it('cancels a pending reasoning request, discards attention, and ignores its late response', async () => {
    const d = mockDebugSession();
    const final = deferred<Awaited<ReturnType<ReasoningFactory>>>();
    let request: Parameters<ReasoningFactory>[0] | undefined;
    const f = fixture(undefined, async (input) => { request = input; input.onRequest?.(preparedRequest); return final.promise; }, undefined, d.debug);
    f.runtime.toggle(); const id = f.id(); await flush();
    f.runtime.toggle(); f.runtime.handle({ type: 'audio-stopped', turnId: id });
    f.sessions[0]!.final.resolve('use this'); await flush();
    expect(f.outputs.at(-1)).toMatchObject({ type: 'state', state: 'interpreting' });
    expect(request?.history.contexts).toHaveLength(1);
    f.runtime.handle({ type: 'cancel' });
    expect(request?.signal.aborted).toBe(true);
    expect(request?.history.contexts).toHaveLength(0);
    f.runtime.handle({ type: 'audio-stopped', turnId: id });
    final.resolve(await reason(request!)); await flush();
    expect(f.outputs.some((output) => output.type === 'result')).toBe(false);
    expect(f.outputs.at(-1)).toMatchObject({ type: 'state', state: 'ready' });
    expect(d.inputs).toHaveLength(1);
    expect(d.requests).toEqual([{ turnId: id, request: preparedRequest }]);
    expect(d.results).toMatchObject([{ turnId: id, result: { status: 'cancelled' } }]);
  });

  it.each([50_000, 185_000])('bounds response latency and remains cancellable if interpretation stalls (%sms)', async (deadline) => {
    vi.useFakeTimers(); const f = fixture(undefined, () => new Promise(() => {}), undefined, undefined, undefined,
      { deadlines: { reasoning: deadline } });
    f.runtime.toggle(); const id = f.id(); await flush();
    f.runtime.toggle(); f.runtime.handle({ type: 'audio-stopped', turnId: id });
    f.sessions[0]!.final.resolve('use this'); await flush();
    await vi.advanceTimersByTimeAsync(deadline - 1);
    expect(f.outputs.some((output) => output.type === 'error')).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.outputs).toContainEqual({ type: 'error', turnId: id,
      message: 'Desktop task timed out. Stopped without confirming completion. Earlier actions may already have occurred; check the current state before retrying.' });
    expect(f.commands.at(-1)).toEqual({ type: 'cancel', turnId: id });
  });

  it('stops the runtime when native cancellation cleanup cannot be confirmed', async () => {
    vi.useFakeTimers(); const f = fixture(); f.runtime.toggle(); f.runtime.cancel();
    const failure = expect(f.runtime.fatal).rejects.toThrow('cleanup could not be confirmed');
    await vi.advanceTimersByTimeAsync(2000); await failure;
    f.runtime.toggle(); expect(f.sessions).toHaveLength(1);
  });

  it('bounds startup and long recordings', async () => {
    vi.useFakeTimers(); const f = fixture(); f.runtime.toggle(); const first = f.id();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.commands.at(-1)).toEqual({ type: 'cancel', turnId: first });
    f.runtime.handle({ type: 'audio-stopped', turnId: first }); f.runtime.toggle();
    const second = f.id(); f.runtime.handle({ type: 'audio-started', turnId: second });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.commands.at(-1)).toEqual({ type: 'stop', turnId: second });
    expect(f.outputs).toContainEqual({ type: 'warning', turnId: second, message: 'Two-minute recording limit reached; finishing this turn.' });
    expect(f.outputs.filter((event) => event.type === 'error' && event.turnId === second)).toEqual([]);
    f.runtime.handle({ type: 'audio-stopped', turnId: second });
    f.sessions[1]!.final.resolve('Finish this long request'); await flush();
    expect(f.outputs).toContainEqual(expect.objectContaining({ type: 'result', turnId: second, response: 'Which window?' }));
    expect(f.outputs.at(-1)).toEqual({ type: 'state', state: 'ready' });
  });
});
