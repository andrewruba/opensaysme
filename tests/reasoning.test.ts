import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AttentionHistory } from '../src/attention.js';
import { defaultReasoningModel, openAIReasoning } from '../src/reasoning/openai.js';
import type { ReasoningInput } from '../src/reasoning/types.js';
import type { ToolDescriptor, ToolEvent, ToolHost, ToolResult } from '../src/tools/types.js';
import type { DiagnosticSink, PreparedReasoningRequest } from '../src/diagnostics.js';
import { createDesktopTools } from '../src/tools/desktop.js';
import type { ConversationTurn } from '../src/conversation.js';

afterEach(() => { vi.useRealTimers(); });
function history(): AttentionHistory {
  return {
    durationMs: 2000, audio: { sampleRate: 24000, samples: 43200, durationMs: 1800,
      firstCapturedAtMs: 100, lastCapturedAtMs: 1900, firstReceivedAtMs: 200, maxDeliveryLagMs: 100, timing: 'device' }, warnings: [],
    frames: [{ id: 'frame-1', atMs: 50, receivedAtMs: 80, capturedAt: '2026-10-29T00:00:00.050Z',
      display: { id: 'display-1', bounds: { x: -1920, y: 0, width: 1920, height: 1080 } },
      image: { mimeType: 'image/jpeg', width: 1600, height: 900, data: '/9j/2Q==' }, warnings: [] }],
    contexts: [{ id: 'context-1', atMs: 40, receivedAtMs: 60, context: {
      platform: 'darwin', capturedAt: '2026-10-29T00:00:00.040Z', warnings: [],
      activeWindow: { id: 'window-1', application: 'Editor', title: 'source' }, selectedText: 'selected content',
      pointer: { x: -100, y: 300, window: { id: 'window-2', application: 'Terminal', title: 'destination' } },
    } }],
    cursor: [{ atMs: 1200, receivedAtMs: 1205, x: -100, y: 300, displayId: 'display-1' }],
    transcript: [{ id: 'phrase-1', startSample: 0, endSample: 24000, startMs: 100, endMs: 1100,
      boundary: 'pause', timing: 'device', receivedAtMs: 1600, text: 'put this here' }],
  };
}
function response(text = 'The indicated number is 42 (frame-1).', status = 'completed'): Response {
  return Response.json({ status, output: [{ type: 'reasoning', summary: [] }, {
    type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }],
  }] });
}
function fixture(fetcher = vi.fn<typeof fetch>().mockResolvedValue(response()), model = 'gpt-5.4-mini') {
  const controller = new AbortController();
  const reason = openAIReasoning({ apiKey: 'fixture-secret-value', model, timeoutMs: 1000 }, fetcher);
  const captured = history();
  const input: ReasoningInput = { history: captured, transcript: 'What is that number?', signal: controller.signal,
    visual: { warnings: [], frames: [{ context: {
      frameId: 'frame-1', atMs: 50, startMs: 0, endMs: 800, phraseIds: ['phrase-1'], contextIds: ['context-1'],
      trails: [{ points: [{ x: 0.2, y: 0.3, atMs: 45 }, { x: 0.22, y: 0.32, atMs: 65 }] }],
      pointer: { x: 0.2, y: 0.3, atMs: 45 }, warnings: [],
    }, image: { ...captured.frames[0]!.image, data: '/9j/4Q==' } }] },
  };
  return { reason, input, fetcher, controller };
}

function priorTurn(): ConversationTurn {
  return { id: 'prior-turn', completedAt: '2026-10-29T00:00:01.000Z',
    request: 'Point to the email field in the Aster form.', response: 'I pointed to Email.',
    referenceContext: history().contexts, evidence: {
      windows: [{ window: { id: 'native-form', application: 'Browser', title: 'Feedback' },
        capturedAt: '2026-10-29T00:00:00.500Z', warnings: [] }],
      actions: [{ window: { id: 'native-form', application: 'Browser', title: 'Feedback' },
        capturedAt: '2026-10-29T00:00:00.500Z', action: { kind: 'move_pointer' }, point: { x: 100, y: 100 },
        target: { role: 'AXTextField', title: 'Email', description: '', value: '',
          bounds: { x: 90, y: 90, width: 200, height: 30 }, focused: false, editable: true },
        effect: 'point', status: 'verified' }],
    } };
}

describe('natural desktop response', () => {
  it('passes historical names as separate evidence while preserving spoken spelling and scope', async () => {
    const f = fixture();
    f.input.transcript = 'Find the Mapel agent. Leave its input unsent.';
    f.input.workContext = [{ application: 'Workspace', title: 'Maple — project', observedAt: '2026-10-29T00:00:00Z' }];
    await f.reason(f.input);
    const wire = JSON.parse(String(f.fetcher.mock.calls[0]![1]!.body));
    const metadata = JSON.parse(wire.input[0].content[0].text);
    expect(metadata.transcript).toBe(f.input.transcript);
    expect(metadata.workContext).toEqual(f.input.workContext);
    expect(metadata.conversation).toEqual([]);
    expect(metadata.workContext[0]).not.toHaveProperty('id');
    f.fetcher.mockClear();
    Object.assign(f.input.workContext[0]!, { request: 'Submit the old request', windowId: 'old-live-handle' });
    await expect(f.reason(f.input)).rejects.toThrow();
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ['gpt-6.1-terra', { effort: 'low' }, 4096],
    ['gpt-6-astra', { effort: 'low' }, 4096],
    ['configured-model', undefined, 2500],
  ] as const)('uses compatible request settings for %s without changing the image contract', async (model, reasoning, maxOutputTokens) => {
    const f = fixture(undefined, model);
    const requests: PreparedReasoningRequest[] = [];
    f.input.onRequest = (request) => requests.push(request);
    await expect(f.reason(f.input)).resolves.toContain('42');
    const wire = JSON.parse(String(f.fetcher.mock.calls[0]![1]!.body));
    expect(wire.model).toBe(model);
    expect(wire.reasoning).toEqual(reasoning);
    expect(wire.max_output_tokens).toBe(maxOutputTokens);
    expect(requests[0]?.reasoning).toEqual(wire.reasoning);
    expect(wire.input[0].content.filter((part: { type: string }) => part.type === 'input_image')).toHaveLength(2);
    expect(wire.temperature).toBeUndefined();
    expect(wire.top_p).toBeUndefined();
  });

  it('supplies historical requests and native outcomes separately from current speech and images', async () => {
    const f = fixture();
    const previous = priorTurn();
    f.input.transcript = 'Click it.';
    f.input.conversation = [previous];
    await f.reason(f.input);
    const body = JSON.parse(String(f.fetcher.mock.calls[0]![1]!.body));
    const parts = body.input[0].content;
    const metadata = JSON.parse(parts[0].text);
    expect(metadata.transcript).toBe('Click it.');
    expect(metadata.conversation).toEqual([previous]);
    expect(metadata.attention.contexts).toEqual(f.input.history.contexts);
    expect(parts.filter((part: { type: string }) => part.type === 'input_image')).toHaveLength(2);
    expect(JSON.stringify(metadata.conversation)).not.toMatch(/observationId|fingerprint|image_url|data:image/);
    expect(body.instructions).toContain('Historical window identities, coordinates and control descriptions are clues, not live tool handles');
    expect(body.instructions).toContain('An assistant suggestion never expands');
  });

  it('rejects oversized or nonconforming history before provider dispatch', async () => {
    const invalid = [
      Array.from({ length: 4 }, () => priorTurn()),
      [{ ...priorTurn(), request: 'x'.repeat(65_537) }],
      [{ ...priorTurn(), approved: true }],
      [{ ...priorTurn(), evidence: { windows: [], actions: [{ ...priorTurn().evidence.actions[0], observationId: 'observation-1' }] } }],
    ];
    for (const conversation of invalid) {
      const f = fixture(); f.input.conversation = conversation as ConversationTurn[];
      await expect(f.reason(f.input)).rejects.toThrow();
      expect(f.fetcher).not.toHaveBeenCalled();
    }
  });

  it('exports the exact prepared prompt/settings with file references before dispatch, without headers or image bytes', async () => {
    const f = fixture();
    const requests: PreparedReasoningRequest[] = [];
    const diagnostic = vi.fn<DiagnosticSink>();
    f.input.onRequest = (request) => requests.push(request);
    f.input.onDiagnostic = diagnostic;
    await f.reason(f.input);
    expect(requests).toHaveLength(1);
    const wire = JSON.parse(String(f.fetcher.mock.calls[0]![1]!.body));
    const content = wire.input[0].content as Array<{ type: string; image_url?: string }>;
    const localImages = ['images/frame-1-clean.jpg', 'images/frame-1-trail.jpg'];
    let image = 0;
    for (const part of content) if (part.type === 'input_image') part.image_url = localImages[image++]!;
    expect(requests[0]).toEqual(wire);
    expect(JSON.stringify(requests)).not.toMatch(/fixture-secret-value|Authorization|data:image|base64|\/9j\//);
    const events = diagnostic.mock.calls.map(([entry]) => entry);
    expect(events.map(({ event }) => event)).toEqual(['request-prepared', 'request-started', 'response-received', 'request-completed']);
    expect(events[2]).toMatchObject({ component: 'reasoning', data: { status: 200 } });
    expect(diagnostic.mock.invocationCallOrder[1]).toBeLessThan(f.fetcher.mock.invocationCallOrder[0]!);
  });

  it('isolates diagnostic mutations and exceptions from the real provider request', async () => {
    const f = fixture();
    f.input.onRequest = (request) => {
      request.model = 'changed by debug callback';
      (request.input[0]!.content as unknown[]).length = 0;
      throw new Error('debug sink failed');
    };
    f.input.onDiagnostic = () => { throw new Error('debug sink failed'); };
    await expect(f.reason(f.input)).resolves.toContain('42');
    const wire = JSON.parse(String(f.fetcher.mock.calls[0]![1]!.body));
    expect(wire.model).toBe('gpt-5.4-mini');
    expect(wire.input[0].content).toHaveLength(5);
  });

  it('records rejected and skipped requests without provider bodies, headers, or private errors', async () => {
    const diagnostic = vi.fn<DiagnosticSink>();
    const f = fixture(vi.fn<typeof fetch>().mockResolvedValue(new Response('fixture-secret-value private body', {
      status: 429, headers: { 'x-request-id': 'fixture-secret-value', Authorization: 'fixture-secret-value' },
    })));
    f.input.onDiagnostic = diagnostic;
    await expect(f.reason(f.input)).rejects.toThrow('HTTP 429');
    expect(diagnostic.mock.calls.map(([entry]) => entry.event)).toContain('request-failed');
    expect(diagnostic.mock.calls).toContainEqual([{ component: 'reasoning', event: 'response-received', data: { status: 429 } }]);
    const g = fixture(); g.input.transcript = ' '; g.input.onDiagnostic = diagnostic; g.input.onRequest = vi.fn();
    await g.reason(g.input);
    expect(g.input.onRequest).not.toHaveBeenCalled();
    expect(diagnostic.mock.calls.at(-1)?.[0]).toMatchObject({ event: 'request-skipped', data: { code: 'empty-transcript' } });
    const h = fixture(); h.input.visual.frames = []; h.input.onDiagnostic = diagnostic; h.input.onRequest = vi.fn();
    await expect(h.reason(h.input)).rejects.toThrow();
    expect(h.input.onRequest).not.toHaveBeenCalled();
    expect(diagnostic.mock.calls.at(-1)?.[0]).toMatchObject({ event: 'request-failed', data: { code: 'invalid-input' } });
    expect(JSON.stringify(diagnostic.mock.calls)).not.toMatch(/fixture-secret-value|private body|Authorization|x-request-id/);
  });

  it('pairs clean frames, full-size trail images, speech, and timed normalized paths in one request', async () => {
    const f = fixture();
    await expect(f.reason(f.input)).resolves.toBe('The indicated number is 42 (frame-1).');
    expect(f.fetcher).toHaveBeenCalledOnce();
    const [url, options] = f.fetcher.mock.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(options?.redirect).toBe('error');
    const body = JSON.parse(String(options?.body));
    expect(body.store).toBe(false);
    expect(body.tools).toBeUndefined();
    expect(body.text).toBeUndefined();
    const parts = body.input[0].content;
    expect(parts.map((part: { type: string }) => part.type)).toEqual(['input_text', 'input_text', 'input_image', 'input_text', 'input_image']);
    expect(parts[1].text).toContain('Clean historical full screen frame frame-1');
    expect(parts[1].text).toContain('"text":"put this here"');
    expect(parts[1].text).toContain('"startMs":100,"endMs":1100');
    expect(parts[2]).toMatchObject({ type: 'input_image', image_url: 'data:image/jpeg;base64,/9j/2Q==', detail: 'high' });
    expect(parts[3].text).toContain('Same full frame frame-1');
    expect(parts[4]).toMatchObject({ type: 'input_image', image_url: 'data:image/jpeg;base64,/9j/4Q==' });
    const metadata = JSON.parse(parts[0].text);
    expect(metadata.attention.frames[0].image.data).toBeUndefined();
    expect(metadata.visual.frames[0].image).toBeUndefined();
    expect(metadata.visual.frames[0]).toMatchObject({
      frameId: 'frame-1', hasTrailImage: true, phraseIds: ['phrase-1'], contextIds: ['context-1'],
      trails: [{ points: [{ x: 0.2, y: 0.3, atMs: 45 }, { x: 0.22, y: 0.32, atMs: 65 }] }],
    });
    expect(metadata.attention.cursor[0]).toMatchObject({ atMs: 1200, receivedAtMs: 1205 });
    expect(metadata.attention.transcript[0]).toMatchObject({ startSample: 0, endSample: 24000, startMs: 100, endMs: 1100,
      timing: 'device', receivedAtMs: 1600, text: 'put this here' });
    expect(metadata.attention.timing).toContain('delivery-only');
    expect(body.instructions).toContain('never interpolate exact word times');
    expect(body.instructions).toContain('not separate tasks');
    expect(body.instructions).toContain('no fixed response structure');
    expect(body.instructions).toContain('untrusted evidence');
    expect(String(options?.body)).not.toContain('fixture-secret-value');
  });

  it('allows free text without JSON and does not force a response category', async () => {
    for (const text of ['The number is 42.', 'I would switch to the Terminal window.', 'Which window do you mean?', '{not structured JSON}']) {
      const f = fixture(vi.fn<typeof fetch>().mockResolvedValue(response(text)));
      await expect(f.reason(f.input)).resolves.toBe(text);
    }
  });

  it('skips empty speech locally and handles absent visuals and absent marks', async () => {
    const f = fixture(); f.input.transcript = ' ';
    await expect(f.reason(f.input)).resolves.toContain('No spoken request');
    expect(f.fetcher).not.toHaveBeenCalled();
    const g = fixture(vi.fn<typeof fetch>().mockResolvedValue(response('Which window do you mean?')));
    g.input.history.frames = []; g.input.visual.frames = [];
    await expect(g.reason(g.input)).resolves.toBe('Which window do you mean?');
    const h = fixture(); h.input.visual.frames[0]!.image = null;
    await h.reason(h.input);
    const body = JSON.parse(String(h.fetcher.mock.calls[0]![1]!.body));
    expect(body.input[0].content.filter((part: { type: string }) => part.type === 'input_image')).toHaveLength(1);
    expect(JSON.parse(body.input[0].content[0].text).visual.frames[0].hasTrailImage).toBe(false);
  });

  it('rejects unmatched, duplicate, missing, or inconsistent visual entries before dispatch', async () => {
    const cases: Array<(input: ReasoningInput) => void> = [
      (input) => { input.visual.frames[0]!.context.frameId = 'unknown'; },
      (input) => { input.visual.frames.push(input.visual.frames[0]!); },
      (input) => { input.visual.frames = []; },
      (input) => { input.visual.frames[0]!.context.atMs = 60; },
      (input) => { input.visual.frames[0]!.context.phraseIds = ['missing']; },
      (input) => { input.visual.frames[0]!.context.contextIds = ['missing']; },
      (input) => { input.visual.frames[0]!.context.trails[0]!.points[0]!.x = -0.1; },
      (input) => { input.visual.frames[0]!.context.trails[0]!.points[0]!.atMs = 900; },
      (input) => { input.visual.frames[0]!.context.trails[0]!.points.reverse(); },
      (input) => { input.visual.frames[0]!.context.trails = Array.from({ length: 65 }, () => input.visual.frames[0]!.context.trails[0]!); },
      (input) => { input.history.frames.push(input.history.frames[0]!); input.visual.frames.push(input.visual.frames[0]!); },
    ];
    for (const mutate of cases) {
      const f = fixture(); mutate(f.input);
      await expect(f.reason(f.input)).rejects.toThrow();
      expect(f.fetcher).not.toHaveBeenCalled();
    }
  });

  it('rejects invalid originals and trail images that are cropped, malformed, or too large', async () => {
    const cases: Array<(input: ReasoningInput) => void> = [
      (input) => { input.history.frames[0]!.image.width = 1601; },
      (input) => { input.history.frames[0]!.image.data = '!bad!'; },
      (input) => { input.visual.frames[0]!.image!.width = 100; },
      (input) => { input.visual.frames[0]!.image!.height = 100; },
      (input) => { input.visual.frames[0]!.image!.data = '!bad!'; },
      (input) => { input.visual.frames[0]!.image!.data = 'a'.repeat(1_400_004); },
    ];
    for (const mutate of cases) {
      const f = fixture(); mutate(f.input);
      await expect(f.reason(f.input)).rejects.toThrow();
      expect(f.fetcher).not.toHaveBeenCalled();
    }
  });

  it('rejects incomplete, refused, empty, nontext, and oversized text without leaking private contents', async () => {
    const cases = [response('private content', 'incomplete'), response(' '), response('x'.repeat(65_537)),
      Response.json({ status: 'completed', output: [{
        type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'refusal', refusal: 'private reason' }],
      }] }), Response.json({ status: 'completed', output: [{ type: 'function_call', name: 'private content' }] }),
      Response.json({ status: 'completed', output: [] }), new Response('private non-JSON')];
    for (const result of cases) {
      const f = fixture(vi.fn<typeof fetch>().mockResolvedValue(result));
      await expect(f.reason(f.input)).rejects.not.toThrow(/private/);
    }
  });

  it('bounds response bytes even without Content-Length', async () => {
    const f = fixture(vi.fn<typeof fetch>().mockResolvedValue(new Response('x'.repeat(131073))));
    await expect(f.reason(f.input)).rejects.toThrow('oversized');
    const g = fixture(vi.fn<typeof fetch>().mockResolvedValue(new Response('small', { headers: { 'Content-Length': '131073' } })));
    await expect(g.reason(g.input)).rejects.toThrow('oversized');
  });

  it('rejects excessive input before a request and sanitizes HTTP/network errors', async () => {
    const large = fixture(); large.input.transcript = 'x'.repeat(65537);
    await expect(large.reason(large.input)).rejects.toThrow('limit');
    expect(large.fetcher).not.toHaveBeenCalled();
    const rejected = fixture(vi.fn<typeof fetch>().mockResolvedValue(new Response('fixture-secret-value', { status: 429 })));
    await expect(rejected.reason(rejected.input)).rejects.toThrow('HTTP 429');
    const network = fixture(vi.fn<typeof fetch>().mockRejectedValue(new Error('fixture-secret-value')));
    await expect(network.reason(network.input)).rejects.toThrow('Could not obtain a valid reasoning response');
  });

  it('bounds total image payload and metadata before making a paid request', async () => {
    const largeImages = fixture();
    largeImages.input.history.frames = Array.from({ length: 12 }, (_, index) => ({
      ...largeImages.input.history.frames[0]!, id: `frame-${index}`, image: {
        ...largeImages.input.history.frames[0]!.image, data: 'a'.repeat(1_400_000),
      },
    }));
    largeImages.input.visual.frames = largeImages.input.history.frames.map((frame) => ({
      context: { ...largeImages.input.visual.frames[0]!.context, frameId: frame.id }, image: frame.image,
    }));
    await expect(largeImages.reason(largeImages.input)).rejects.toThrow('request limit');
    expect(largeImages.fetcher).not.toHaveBeenCalled();
    const largeMetadata = fixture();
    largeMetadata.input.history.contexts[0]!.context.selectedText = 'x'.repeat(512 * 1024);
    await expect(largeMetadata.reason(largeMetadata.input)).rejects.toThrow('metadata limit');
    expect(largeMetadata.fetcher).not.toHaveBeenCalled();
  });

  it('cancels before dispatch and while waiting, and clears its timeout', async () => {
    vi.useFakeTimers();
    const diagnostic = vi.fn<DiagnosticSink>();
    const before = fixture(); before.controller.abort();
    before.input.onDiagnostic = diagnostic;
    await expect(before.reason(before.input)).rejects.toThrow('cancelled');
    expect(before.fetcher).not.toHaveBeenCalled();
    const waiting = vi.fn<typeof fetch>((_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new Error('private abort reason')), { once: true });
    }));
    const during = fixture(waiting);
    during.input.onDiagnostic = diagnostic;
    const cancel = expect(during.reason(during.input)).rejects.toThrow('cancelled');
    during.controller.abort(); await cancel;
    expect(vi.getTimerCount()).toBe(0);
    const timeout = fixture(waiting);
    timeout.input.onDiagnostic = diagnostic;
    const pending = expect(timeout.reason(timeout.input)).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(1000); await pending;
    expect(vi.getTimerCount()).toBe(0);
    expect(diagnostic.mock.calls.filter(([entry]) => entry.event === 'request-cancelled')).toHaveLength(2);
    expect(diagnostic.mock.calls.at(-1)?.[0].event).toBe('request-timed-out');
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('private abort reason');
  });

  it('cancels an unfinished response body and releases its reader', async () => {
    const cancelBody = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{')); }, cancel: cancelBody,
    });
    const f = fixture(vi.fn<typeof fetch>().mockResolvedValue(new Response(stream)));
    const waiting = expect(f.reason(f.input)).rejects.toThrow('cancelled');
    await Promise.resolve();
    f.controller.abort();
    await waiting;
    expect(cancelBody).toHaveBeenCalledOnce();
  });
});

const descriptors: ToolDescriptor[] = [
  { name: 'list_windows', description: 'List available desktop windows.', effect: 'read', inputSchema: {
    type: 'object', properties: {}, required: [], additionalProperties: false,
  } },
  { name: 'focus_window', description: 'Focus a discovered window.', effect: 'focus', inputSchema: {
    type: 'object', properties: { windowId: { type: 'string' } }, required: ['windowId'], additionalProperties: false,
  } },
  { name: 'capture_screen', description: 'Capture the current display.', effect: 'read', inputSchema: {
    type: 'object', properties: {}, required: [], additionalProperties: false,
  } },
];
function toolHost() {
  return { list: vi.fn(() => structuredClone(descriptors)),
    call: vi.fn<ToolHost['call']>(async () => ({ content: [{ type: 'text', text: 'Operation completed.' }] })),
    close: vi.fn(),
  } satisfies ToolHost;
}
function callItem(name = 'list_windows', args: unknown = {}, callId = 'call-1') {
  return { type: 'function_call', name, arguments: JSON.stringify(args), call_id: callId, status: 'completed' };
}
function assistantItem(text: string) {
  return { type: 'message', role: 'assistant', status: 'completed', phase: 'commentary', content: [{ type: 'output_text', text }] };
}
function callResponse(...output: unknown[]) { return Response.json({ status: 'completed', output }); }

describe('desktop tool reasoning loop', () => {
  it('carries selected multiline context through the actor tool call without sending it', async () => {
    const selected = 'TypeError: missing value\r\n\tat render (app.ts:12)\n';
    const text = `${selected}\nPlease explain why this happens with 日本語 input.`;
    const request = 'Put this error and my explanation into the agent input. Leave it unsent.';
    const window = { id: 'agent-window', application: 'Editor', title: 'Agent' };
    const target = { fingerprint: 'a'.repeat(64), role: 'AXTextArea', title: 'Agent input', description: '', value: '',
      bounds: { x: 0, y: 0, width: 800, height: 600 }, focused: true, editable: true };
    const execute = vi.fn(async () => ({ status: 'verified' as const }));
    const authorize = vi.fn(async () => ({ decision: 'allow' as const, effect: 'edit' as const,
      requestQuote: request, reason: 'Scripted preparation decision.' }));
    const host = createDesktopTools({ listWindows: async () => ({ windows: [window], warnings: [] }),
      focus: async () => {}, inspect: async () => ({ platform: 'test', window }), captureContext: vi.fn(), captureFrame: vi.fn(),
      captureWindow: async () => ({ status: 'ok', window, capturedAt: '2026-10-30T12:00:00Z', bounds: target.bounds,
        image: { mimeType: 'image/jpeg', width: 800, height: 600, data: '/9j/AA==' }, warnings: [] }),
      input: { inspect: async () => target, execute },
    }, { request, authorize });
    const fetcher = vi.fn<typeof fetch>()
      .mockImplementationOnce(async (_url, init) => {
        const metadata = JSON.parse(JSON.parse(String(init?.body)).input[0].content[0].text);
        expect(metadata.attention.contexts[0].context.selectedText).toBe(selected);
        return callResponse(callItem());
      })
      .mockResolvedValueOnce(callResponse(callItem('focus_window', { windowId: 'window-1' }, 'focus')))
      .mockResolvedValueOnce(callResponse(callItem('capture_window', { windowId: 'window-1' }, 'capture')))
      .mockResolvedValueOnce(callResponse(callItem('type_text', { observationId: 'observation-1', x: 100, y: 100, text }, 'write')))
      .mockResolvedValueOnce(response('Prepared the explanation and left it unsent.'));
    const f = fixture(fetcher); f.input.transcript = request; f.input.tools = host;
    f.input.history.contexts[0]!.context.selectedText = selected;
    try {
      await f.reason(f.input);
      expect(execute).toHaveBeenCalledExactlyOnceWith({ windowId: window.id, bounds: target.bounds, point: { x: 100, y: 100 } },
        { kind: 'type_text', text }, target.fingerprint, expect.any(AbortSignal));
      expect(authorize).not.toHaveBeenCalled();
    } finally { host.close(); }
  });

  it('passes a verified window image to reasoning after unavailable accessibility content', async () => {
    const window = { id: 'native-target', application: 'Editor', title: 'Project' };
    const image = { mimeType: 'image/jpeg' as const, width: 1600, height: 1200, data: '/9j/AA==' };
    const capture = vi.fn(async () => ({ status: 'ok' as const, capturedAt: '2026-10-29T12:00:00Z', window,
      bounds: { x: -1200, y: -100, width: 800, height: 600 }, image, warnings: ['Protected content may be blank.'] }));
    const focus = vi.fn(async () => {});
    const host = createDesktopTools({
      listWindows: async () => ({ windows: [window], warnings: [] }),
      inspectWindow: async () => ({ status: 'unavailable', reason: 'inaccessible' }),
      captureWindow: capture, focus, inspect: async () => ({ platform: 'test', window }),
      captureContext: vi.fn(), captureFrame: vi.fn(),
    });
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(callResponse(callItem()))
      .mockResolvedValueOnce(callResponse(callItem('inspect_window', { windowId: 'window-1' }, 'text')))
      .mockImplementationOnce(async (_url, init) => {
        expect(JSON.parse(String(init?.body)).input.at(-1).output[0]).toEqual({ type: 'input_text', text: '{"isError":true}' });
        return callResponse(callItem('capture_window', { windowId: 'window-1' }, 'pixels'));
      })
      .mockImplementationOnce(async (_url, init) => {
        expect(focus).not.toHaveBeenCalled();
        const output = JSON.parse(String(init?.body)).input.at(-1).output;
        expect(JSON.parse(output[1].text)).toMatchObject({ source: 'window-screenshot', window: { windowId: 'window-1', title: 'Project' },
          capturedAt: '2026-10-29T12:00:00Z', bounds: { x: -1200, y: -100, width: 800, height: 600 },
          image: { width: 1600, height: 1200 } });
        expect(output[2]).toEqual({ type: 'input_image', image_url: `data:image/jpeg;base64,${image.data}`, detail: 'high' });
        expect(JSON.stringify(output)).not.toContain('native-target');
        return callResponse(callItem('focus_window', { windowId: 'window-1' }, 'focus'));
      })
      .mockResolvedValueOnce(response('Switched to the requested project.'));
    const f = fixture(fetcher); f.input.tools = host; f.input.transcript = 'Switch to the project with the blue diagram';
    await expect(f.reason(f.input)).resolves.toBe('Switched to the requested project.');
    expect(capture).toHaveBeenCalledExactlyOnceWith('native-target', expect.any(AbortSignal));
    expect(focus).toHaveBeenCalledExactlyOnceWith('native-target', expect.any(AbortSignal));
    host.close();
  });

  it('feeds candidate contents and their sources back before focusing one of two equally titled windows', async () => {
    const candidates = [
      { id: 'native-api', application: 'Editor', title: 'Project' },
      { id: 'native-web', application: 'Editor', title: 'Project' },
    ];
    let focused = candidates[0]!;
    const focus = vi.fn(async (id: string) => { focused = candidates.find((window) => window.id === id)!; });
    const host = createDesktopTools({
      listWindows: async () => ({ windows: candidates, warnings: [] }),
      inspectWindow: async (id) => ({ status: 'ok', capturedAt: '2026-10-29T12:00:00Z',
        window: candidates.find((window) => window.id === id)!,
        nodes: [{ parent: null, role: 'AXTextArea', value: id === 'native-web' ? 'frontend/src/App.tsx' : 'backend/server.ts' }],
        warnings: ['Virtualized content may be missing.'] }),
      focus, inspect: async () => ({ platform: 'test', window: focused }),
      captureContext: vi.fn(), captureFrame: vi.fn(),
    });
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(callResponse(callItem()))
      .mockResolvedValueOnce(callResponse(callItem('inspect_window', { windowId: 'window-1' }, 'inspect-api')))
      .mockResolvedValueOnce(callResponse(callItem('inspect_window', { windowId: 'window-2' }, 'inspect-web')))
      .mockImplementationOnce(async (_url, init) => {
        expect(focus).not.toHaveBeenCalled();
        const wire = JSON.parse(String(init?.body));
        const evidence = wire.input.filter((item: { type: string }) => item.type === 'function_call_output');
        const inspected = evidence.slice(1).map((item: { output: Array<{ text: string }> }) => JSON.parse(item.output[1]!.text));
        expect(inspected).toMatchObject([
          { source: 'accessibility', window: { windowId: 'window-1' }, nodes: [{ value: 'backend/server.ts' }] },
          { source: 'accessibility', window: { windowId: 'window-2' }, nodes: [{ value: 'frontend/src/App.tsx' }] },
        ]);
        expect(inspected[1]).toMatchObject({ capturedAt: '2026-10-29T12:00:00Z', warnings: ['Virtualized content may be missing.'] });
        expect(JSON.stringify(evidence)).not.toContain('native-');
        return callResponse(callItem('focus_window', { windowId: 'window-2' }, 'focus-web'));
      })
      .mockResolvedValueOnce(response('Switched to the frontend project.'));
    const f = fixture(fetcher); f.input.tools = host; f.input.transcript = 'Switch to the frontend project';
    await expect(f.reason(f.input)).resolves.toBe('Switched to the frontend project.');
    expect(focus).toHaveBeenCalledExactlyOnceWith('native-web', expect.any(AbortSignal));
    host.close();
  });

  it('discovers two VSCode windows, focuses the matching evidence, and answers without names configured by the user', async () => {
    const thinking = { type: 'reasoning', id: 'reason-1', summary: [], encrypted_content: 'encrypted-fixture' };
    const commentary = assistantItem('I will check the open windows.');
    const listing = callItem();
    const switching = callItem('focus_window', { windowId: 'discovered-frontend' }, 'call-2');
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(callResponse(thinking, commentary, listing))
      .mockResolvedValueOnce(callResponse(switching))
      .mockResolvedValueOnce(response('Switched to the frontend project.'));
    const f = fixture(fetcher, defaultReasoningModel); const host = toolHost(); f.input.tools = host;
    f.input.transcript = 'Switch to the frontend';
    host.call.mockImplementation(async (name) => name === 'list_windows' ? { content: [{ type: 'text', text: JSON.stringify({ windows: [
      { id: 'discovered-api', application: 'Visual Studio Code', title: 'server.ts — api' },
      { id: 'discovered-frontend', application: 'Visual Studio Code', title: 'App.tsx — frontend' },
    ] }) }] } : { content: [{ type: 'text', text: JSON.stringify({ focused: true, title: 'App.tsx — frontend' }) }] });
    const events: ToolEvent[] = []; const requests: Array<{ step?: number; request: PreparedReasoningRequest }> = [];
    f.input.onTool = (event) => events.push(event);
    f.input.onRequest = (request, step) => requests.push({ step, request });
    await expect(f.reason(f.input)).resolves.toBe('Switched to the frontend project.');
    expect(host.call.mock.calls.map(([name, args]) => [name, args])).toEqual([
      ['list_windows', {}], ['focus_window', { windowId: 'discovered-frontend' }],
    ]);
    expect(events.map(({ name, phase }) => [name, phase])).toEqual([
      ['list_windows', 'started'], ['list_windows', 'completed'], ['focus_window', 'started'], ['focus_window', 'completed'],
    ]);
    expect(events[3]).toMatchObject({ effect: 'focus', durationMs: expect.any(Number), result: { content: expect.any(Array) } });
    expect(requests.map(({ step }) => step)).toEqual([1, 2, 3]);
    const wire = fetcher.mock.calls.map(([, init]) => JSON.parse(String(init!.body)));
    expect(wire[0].tools.map((tool: { name: string }) => tool.name)).toEqual(descriptors.map(({ name }) => name));
    expect(wire[0]).toMatchObject({ store: false, parallel_tool_calls: false, tool_choice: 'auto', include: ['reasoning.encrypted_content'] });
    expect(wire[1].input.slice(1, 4)).toEqual([thinking, commentary, listing]);
    expect(wire[1].input[4]).toMatchObject({ type: 'function_call_output', call_id: 'call-1', output: [
      { type: 'input_text', text: '{"isError":false}' }, { type: 'input_text', text: expect.stringContaining('discovered-frontend') },
    ] });
    expect(wire[2].input.at(-1)).toMatchObject({ call_id: 'call-2', output: expect.any(Array) });
    for (const request of wire) {
      expect(request.previous_response_id).toBeUndefined();
      expect(request).toMatchObject({ model: 'gpt-6.1-terra', reasoning: { effort: 'low' }, max_output_tokens: 4096 });
    }
    expect(wire[0].instructions).toContain('Never require the user to register window names');
    expect(wire[0].instructions).toContain('before asking the user');
    expect(JSON.stringify(requests)).not.toContain('fixture-secret-value');
  });

  it('returns a normal answer directly without invoking offered tools', async () => {
    const f = fixture(); const host = toolHost(); f.input.tools = host;
    await expect(f.reason(f.input)).resolves.toContain('42');
    expect(host.call).not.toHaveBeenCalled(); expect(f.fetcher).toHaveBeenCalledOnce();
  });

  it('feeds tool errors to the model so it can recover from new evidence', async () => {
    const f = fixture(vi.fn<typeof fetch>()
      .mockResolvedValueOnce(callResponse(callItem('focus_window', { windowId: 'stale' })))
      .mockResolvedValueOnce(callResponse(callItem('list_windows', {}, 'call-2')))
      .mockResolvedValueOnce(response('That window has closed; only the backend remains.')));
    const host = toolHost(); f.input.tools = host;
    host.call.mockResolvedValueOnce({ isError: true, content: [{ type: 'text', text: 'The window is stale; inspect again.' }] });
    await expect(f.reason(f.input)).resolves.toContain('closed');
    const next = JSON.parse(String(f.fetcher.mock.calls[1]![1]!.body));
    expect(next.input.at(-1).output[0].text).toBe('{"isError":true}');
    expect(host.call).toHaveBeenCalledTimes(2);
  });

  it.each([true, false])('sends screenshot tool results and editable:%s focus evidence together to the model', async (editable) => {
    const f = fixture(vi.fn<typeof fetch>().mockResolvedValueOnce(callResponse(callItem('capture_screen'))).mockResolvedValueOnce(response('I can see the editor.')));
    const host = toolHost(); f.input.tools = host;
    const focus = JSON.stringify({ keyboardObservationId: 'keyboard-1', keyboardFocus: {
      application: 'Agent', role: editable ? 'AXTextArea' : 'AXWebArea', title: 'Conversation',
      description: '', value: '', valueTruncated: false, editable,
    } });
    host.call.mockResolvedValueOnce({ content: [{ type: 'text', text: focus },
      { type: 'image', mimeType: 'image/jpeg', data: '/9j/2Q==' }] });
    const requests: PreparedReasoningRequest[] = []; f.input.onRequest = (request) => requests.push(request);
    await f.reason(f.input);
    const wire = JSON.parse(String(f.fetcher.mock.calls[1]![1]!.body));
    expect(wire.input.at(-1)).toMatchObject({ type: 'function_call_output', call_id: 'call-1', output: [
      { type: 'input_text' }, { type: 'input_text', text: focus },
      { type: 'input_image', image_url: 'data:image/jpeg;base64,/9j/2Q==', detail: 'high' },
    ] });
    expect(requests[1]!.input.at(-1)).toEqual(wire.input.at(-1));
    expect((requests[1]!.input[0]!.content as Array<{ image_url?: string }>)[2]!.image_url).toBe('images/frame-1-clean.jpg');
  });

  it('validates the entire output before executing a tool and rejects unsolicited capabilities', async () => {
    const badOutputs = [
      [callItem(), callItem('capture_screen', {}, 'call-2')],
      [callItem(), { ...assistantItem(''), content: [{ type: 'refusal', refusal: 'private refusal' }] }],
      [callItem(), { ...assistantItem('private'), status: 'incomplete' }],
      [callItem(), { type: 'unexpected', content: 'private content' }],
      [{ ...callItem(), status: 'in_progress' }],
      [{ ...callItem(), status: null }],
      [{ ...callItem(), arguments: 'not JSON' }],
      [callItem('list_windows', [])],
      [callItem('run_shell', { command: 'private command' })],
    ];
    for (const output of badOutputs) {
      const f = fixture(vi.fn<typeof fetch>().mockResolvedValue(callResponse(...output))); const host = toolHost(); f.input.tools = host;
      await expect(f.reason(f.input)).rejects.not.toThrow(/private/);
      expect(host.call).not.toHaveBeenCalled();
    }
    const f = fixture(vi.fn<typeof fetch>().mockResolvedValue(callResponse(callItem())));
    await expect(f.reason(f.input)).rejects.toThrow('valid reasoning response');
  });

  it('accepts omitted call status and ignores commentary claims until the actual tool result is read', async () => {
    const call = callItem(); Reflect.deleteProperty(call, 'status');
    const f = fixture(vi.fn<typeof fetch>()
      .mockResolvedValueOnce(callResponse(assistantItem('I already switched it.'), call))
      .mockResolvedValueOnce(response('I could not switch that window.')));
    const host = toolHost(); f.input.tools = host;
    host.call.mockResolvedValueOnce({ isError: true, content: [{ type: 'text', text: 'Focus failed.' }] });
    await expect(f.reason(f.input)).resolves.toBe('I could not switch that window.');
  });

  it('rejects repeated call IDs before replaying a side effect', async () => {
    const f = fixture(vi.fn<typeof fetch>().mockImplementation(async () => callResponse(callItem()))); const host = toolHost(); f.input.tools = host;
    await expect(f.reason(f.input)).rejects.toThrow('valid reasoning response');
    expect(host.call).toHaveBeenCalledOnce(); expect(f.fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])('enforces the tool budget even if the model ignores tool_choice none (input=%s)', async (inputEnabled) => {
    let index = 0;
    const f = fixture(vi.fn<typeof fetch>().mockImplementation(async () => callResponse(callItem('list_windows', {}, `call-${++index}`))));
    const host = toolHost(); f.input.tools = host;
    const limit = inputEnabled ? 24 : 5;
    if (inputEnabled) host.list.mockReturnValue([...descriptors, { name: 'click', description: 'Guarded input fixture',
      effect: 'input', inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false } }]);
    await expect(f.reason(f.input)).resolves.toContain('tool limit');
    expect(host.call).toHaveBeenCalledTimes(limit); expect(f.fetcher).toHaveBeenCalledTimes(limit + 1);
    expect(JSON.parse(String(f.fetcher.mock.calls[limit]![1]!.body)).tool_choice).toBe('none');
  });

  it('cancels immediately before a tool and during a tool without publishing or requesting anything later', async () => {
    const f = fixture(vi.fn<typeof fetch>().mockResolvedValue(callResponse(callItem()))); const host = toolHost(); f.input.tools = host;
    f.input.onTool = () => f.controller.abort();
    await expect(f.reason(f.input)).rejects.toThrow('cancelled');
    expect(host.call).not.toHaveBeenCalled();
    const g = fixture(vi.fn<typeof fetch>().mockResolvedValue(callResponse(callItem()))); const second = toolHost(); g.input.tools = second;
    let entered!: () => void; const started = new Promise<void>((resolve) => { entered = resolve; });
    let done!: (result: ToolResult) => void;
    second.call.mockImplementation(() => { entered(); return new Promise((resolve) => { done = resolve; }); });
    const events: ToolEvent[] = []; g.input.onTool = (event) => events.push(event);
    const result = expect(g.reason(g.input)).rejects.toThrow('cancelled');
    await started; g.controller.abort(); await result;
    expect(second.call.mock.calls[0]![2].aborted).toBe(true);
    done({ content: [{ type: 'text', text: 'Late success.' }] }); await Promise.resolve();
    expect(events.map(({ phase }) => phase)).toEqual(['started']); expect(g.fetcher).toHaveBeenCalledOnce();
  });

  it('enforces a whole-turn deadline even for a tool that ignores cancellation', async () => {
    vi.useFakeTimers();
    const f = fixture(vi.fn<typeof fetch>().mockResolvedValue(callResponse(callItem()))); const host = toolHost(); f.input.tools = host;
    let entered!: () => void; const started = new Promise<void>((resolve) => { entered = resolve; });
    host.call.mockImplementation(() => { entered(); return new Promise(() => {}); });
    const result = expect(f.reason(f.input)).rejects.toThrow('timed out');
    await started; await vi.advanceTimersByTimeAsync(45_000); await result;
    expect(host.call.mock.calls[0]![2].aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0); expect(f.fetcher).toHaveBeenCalledOnce();
  });

  it('isolates diagnostic mutations from tool execution and result replay', async () => {
    const f = fixture(vi.fn<typeof fetch>().mockResolvedValueOnce(callResponse(callItem('focus_window', { windowId: 'actual' }))).mockResolvedValueOnce(response('Done.')));
    const host = toolHost(); f.input.tools = host;
    f.input.onTool = (event) => {
      event.arguments.windowId = 'mutated';
      if (event.result) event.result.content = [{ type: 'text', text: 'mutated result' }];
      throw new Error('private diagnostic failure');
    };
    f.input.onRequest = (request) => { if (request.tools) request.tools[0]!.name = 'mutated'; };
    await expect(f.reason(f.input)).resolves.toBe('Done.');
    expect(host.call.mock.calls[0]![1]).toEqual({ windowId: 'actual' });
    const wire = JSON.parse(String(f.fetcher.mock.calls[1]![1]!.body));
    expect(wire.tools[0].name).toBe('list_windows');
    expect(wire.input.at(-1).output.at(-1).text).toBe('Operation completed.');
  });

  it('sanitizes thrown and oversized tool failures before letting the model recover', async () => {
    for (const result of [new Error('fixture-secret-value private error'), { content: [{ type: 'text', text: 'x'.repeat(512 * 1024 + 1) }] }]) {
      const f = fixture(vi.fn<typeof fetch>().mockResolvedValueOnce(callResponse(callItem())).mockResolvedValueOnce(response('Desktop inspection is unavailable.')));
      const host = toolHost(); f.input.tools = host;
      if (result instanceof Error) host.call.mockRejectedValueOnce(result); else host.call.mockResolvedValueOnce(result as ToolResult);
      await expect(f.reason(f.input)).resolves.toContain('unavailable');
      const wire = String(f.fetcher.mock.calls[1]![1]!.body);
      expect(wire).not.toMatch(/fixture-secret-value|private error/);
      expect(wire).toContain('invalid result');
    }
  });
});
