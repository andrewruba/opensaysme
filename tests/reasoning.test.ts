import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AttentionHistory } from '../src/attention.js';
import { openAIReasoning } from '../src/reasoning/openai.js';
import type { ReasoningInput } from '../src/reasoning/types.js';

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
function fixture(fetcher = vi.fn<typeof fetch>().mockResolvedValue(response())) {
  const controller = new AbortController();
  const reason = openAIReasoning({ apiKey: 'fixture-secret-value', model: 'gpt-5.4-mini', timeoutMs: 1000 }, fetcher);
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

describe('natural desktop response', () => {
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
    const before = fixture(); before.controller.abort();
    await expect(before.reason(before.input)).rejects.toThrow('cancelled');
    expect(before.fetcher).not.toHaveBeenCalled();
    const waiting = vi.fn<typeof fetch>((_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new Error('private abort reason')), { once: true });
    }));
    const during = fixture(waiting);
    const cancel = expect(during.reason(during.input)).rejects.toThrow('cancelled');
    during.controller.abort(); await cancel;
    expect(vi.getTimerCount()).toBe(0);
    const timeout = fixture(waiting);
    const pending = expect(timeout.reason(timeout.input)).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(1000); await pending;
    expect(vi.getTimerCount()).toBe(0);
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
