import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AttentionHistory } from '../src/attention.js';
import { openAIActionPreview } from '../src/preview/openai.js';
import { validatePreview, type ActionPreview } from '../src/preview/types.js';

afterEach(() => { vi.useRealTimers(); });
function history(): AttentionHistory {
  return {
    durationMs: 2000, audio: { firstChunkAtMs: 200, durationMs: 1800 }, warnings: [],
    frames: [{ id: 'frame-1', atMs: 50, receivedAtMs: 80, capturedAt: '2026-10-29T00:00:00.050Z',
      display: { id: 'display-1', bounds: { x: -1920, y: 0, width: 1920, height: 1080 } },
      image: { mimeType: 'image/jpeg', width: 1600, height: 900, data: '/9j/2Q==' }, warnings: [] }],
    contexts: [{ id: 'context-1', atMs: 40, receivedAtMs: 60, context: {
      platform: 'darwin', capturedAt: '2026-10-29T00:00:00.040Z', warnings: [],
      activeWindow: { id: 'window-1', application: 'Editor', title: 'source' }, selectedText: 'selected content',
      pointer: { x: -100, y: 300, window: { id: 'window-2', application: 'Terminal', title: 'destination' } },
    } }],
    cursor: [{ atMs: 1200, receivedAtMs: 1205, x: -100, y: 300, displayId: 'display-1' }],
    transcript: [{ receivedAtMs: 1600, text: 'put this here' }],
  };
}
function proposal(): ActionPreview {
  return { action: 'insert_text', summary: 'Insert the indicated content into the selected destination.', text: 'selected content', clarification: null,
    references: [
      { role: 'source', description: 'Indicated region', frameId: 'frame-1', contextId: 'context-1', windowId: 'window-1',
        region: { x: 0.2, y: 0.3, width: 0.2, height: 0.1 } },
      { role: 'target', description: 'Destination window', frameId: null, contextId: 'context-1', windowId: 'window-2', region: null },
    ] };
}
function response(value: unknown = proposal(), status = 'completed'): Response {
  return Response.json({ status, output: [{ type: 'reasoning', summary: [] }, {
    type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(value), annotations: [] }],
  }] });
}
function fixture(fetcher = vi.fn<typeof fetch>().mockResolvedValue(response())) {
  const controller = new AbortController();
  const preview = openAIActionPreview({ apiKey: 'fixture-secret-value', model: 'gpt-5.4-mini', timeoutMs: 1000 }, fetcher);
  const input = { history: history(), transcript: 'Put this here', signal: controller.signal };
  return { preview, input, fetcher, controller };
}

describe('action preview', () => {
  it('sends one bounded multimodal request and returns validated historical references', async () => {
    const f = fixture();
    await expect(f.preview(f.input)).resolves.toEqual(proposal());
    expect(f.fetcher).toHaveBeenCalledOnce();
    const [url, options] = f.fetcher.mock.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(options?.redirect).toBe('error');
    const body = JSON.parse(String(options?.body));
    expect(body.store).toBe(false);
    expect(body.tools).toBeUndefined();
    expect(body.text.format).toMatchObject({ type: 'json_schema', strict: true });
    expect(body.input[0].content.at(-1)).toMatchObject({ type: 'input_image', image_url: 'data:image/jpeg;base64,/9j/2Q==' });
    const metadata = JSON.parse(body.input[0].content[0].text);
    expect(metadata.attention.frames[0].image.data).toBeUndefined();
    expect(metadata.attention.cursor[0]).toMatchObject({ atMs: 1200, receivedAtMs: 1205 });
    expect(metadata.attention.transcript[0]).toEqual({ receivedAtMs: 1600, text: 'put this here' });
    expect(metadata.attention.timing).toContain('receipt-only');
    expect(String(options?.body)).not.toContain('fixture-secret-value');
  });

  it('can ask for clarification with missing visual evidence and empty speech without a call', async () => {
    const f = fixture(); f.input.transcript = ' ';
    await expect(f.preview(f.input)).resolves.toMatchObject({ action: 'clarify', text: null });
    expect(f.fetcher).not.toHaveBeenCalled();
    const p: ActionPreview = { action: 'clarify', summary: 'The destination is unclear.', text: null,
      references: [], clarification: 'Which window should receive this?' };
    const g = fixture(vi.fn<typeof fetch>().mockResolvedValue(response(p)));
    g.input.history.frames = [];
    await expect(g.preview(g.input)).resolves.toEqual(p);
  });

  it('rejects invented IDs, mismatched contexts, and out-of-frame regions', () => {
    const missingFrame = proposal(); missingFrame.references[0]!.frameId = 'invented';
    expect(() => validatePreview(missingFrame, history())).toThrow('Unknown frame');
    const missingWindow = proposal(); missingWindow.references[1]!.windowId = 'invented';
    expect(() => validatePreview(missingWindow, history())).toThrow('Unknown window');
    const wrongContext = history(); wrongContext.contexts.push({ ...wrongContext.contexts[0]!, id: 'other',
      context: { ...wrongContext.contexts[0]!.context, activeWindow: null, pointer: undefined } });
    const bad = proposal(); bad.references[1]!.contextId = 'other';
    expect(() => validatePreview(bad, wrongContext)).toThrow('does not belong');
    const region = proposal(); region.references[0]!.region!.width = 0.9;
    expect(() => validatePreview(region, history())).toThrow('Invalid region');
  });

  it('requires action-specific evidence and rejects executable payload fields', () => {
    expect(() => validatePreview({ ...proposal(), shell: 'do something' }, history())).toThrow();
    expect(() => validatePreview({ ...proposal(), text: null }, history())).toThrow('Invalid action text');
    expect(() => validatePreview({ ...proposal(), action: 'focus_window', text: null, references: [] }, history())).toThrow('target window');
    expect(() => validatePreview({ ...proposal(), action: 'clarify', text: null }, history())).toThrow('clarification');
    const back = { ...proposal(), action: 'return_to_previous', text: null };
    expect(() => validatePreview(back, history())).toThrow('Previous window');
  });

  it('resolves a previous window from distinct focus history, not repeated samples', () => {
    const observed = history();
    observed.contexts.push({ ...observed.contexts[0]!, id: 'context-2', atMs: 1000, receivedAtMs: 1010,
      context: { ...observed.contexts[0]!.context, activeWindow: { id: 'window-2', application: 'Terminal' } } });
    const back: ActionPreview = { ...proposal(), action: 'return_to_previous', text: null,
      references: [{ ...proposal().references[0]!, role: 'target' }] };
    expect(validatePreview(back, observed)).toEqual(back);
    observed.contexts[1]!.context.activeWindow = null;
    observed.contexts.push({ ...observed.contexts[0]!, id: 'context-3', atMs: 1500, receivedAtMs: 1510 });
    expect(() => validatePreview(back, observed)).toThrow('Previous window');
  });

  it('rejects incomplete, refused, and invalid provider responses without leaking their text', async () => {
    const cases = [response(proposal(), 'incomplete'), Response.json({ status: 'completed', output: [{
      type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'refusal', refusal: 'private reason' }],
    }] }), response({ ...proposal(), references: [{ ...proposal().references[0], frameId: 'private-invented' }] })];
    for (const result of cases) {
      const f = fixture(vi.fn<typeof fetch>().mockResolvedValue(result));
      await expect(f.preview(f.input)).rejects.not.toThrow(/private/);
    }
  });

  it('bounds response bytes even without Content-Length', async () => {
    const f = fixture(vi.fn<typeof fetch>().mockResolvedValue(new Response('x'.repeat(131073))));
    await expect(f.preview(f.input)).rejects.toThrow('oversized');
    const g = fixture(vi.fn<typeof fetch>().mockResolvedValue(new Response('small', { headers: { 'Content-Length': '131073' } })));
    await expect(g.preview(g.input)).rejects.toThrow('oversized');
  });

  it('rejects excessive input before a request and sanitizes HTTP/network errors', async () => {
    const large = fixture(); large.input.transcript = 'x'.repeat(65537);
    await expect(large.preview(large.input)).rejects.toThrow('limit');
    expect(large.fetcher).not.toHaveBeenCalled();
    const rejected = fixture(vi.fn<typeof fetch>().mockResolvedValue(new Response('fixture-secret-value', { status: 429 })));
    await expect(rejected.preview(rejected.input)).rejects.toThrow('HTTP 429');
    const network = fixture(vi.fn<typeof fetch>().mockRejectedValue(new Error('fixture-secret-value')));
    await expect(network.preview(network.input)).rejects.toThrow('Could not obtain a valid action preview');
  });

  it('cancels before dispatch and while waiting, and clears its timeout', async () => {
    vi.useFakeTimers();
    const before = fixture(); before.controller.abort();
    await expect(before.preview(before.input)).rejects.toThrow('cancelled');
    expect(before.fetcher).not.toHaveBeenCalled();
    const waiting = vi.fn<typeof fetch>((_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new Error('private abort reason')), { once: true });
    }));
    const during = fixture(waiting);
    const cancel = expect(during.preview(during.input)).rejects.toThrow('cancelled');
    during.controller.abort(); await cancel;
    expect(vi.getTimerCount()).toBe(0);
    const timeout = fixture(waiting);
    const pending = expect(timeout.preview(timeout.input)).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(1000); await pending;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels an unfinished response body and releases its reader', async () => {
    const cancelBody = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{')); }, cancel: cancelBody,
    });
    const f = fixture(vi.fn<typeof fetch>().mockResolvedValue(new Response(stream)));
    const waiting = expect(f.preview(f.input)).rejects.toThrow('cancelled');
    await Promise.resolve();
    f.controller.abort();
    await waiting;
    expect(cancelBody).toHaveBeenCalledOnce();
  });
});
