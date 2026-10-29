import { link, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { screenFrameCaptureSchema, type ScreenFrameCapture } from './desktop/visual-types.js';
import type { DebugSession, DebugTurnInput, PreparedReasoningRequest } from './diagnostics.js';

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const time = z.number().finite().nonnegative();
const point = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), atMs: time });
const alignmentSchema = z.object({
  frameId: identifier, atMs: time, startMs: time, endMs: time,
  phraseIds: z.array(z.string().max(512)).max(512), contextIds: z.array(z.string().max(512)).max(24),
  trails: z.array(z.object({ points: z.array(point).min(1).max(128) })).max(128), pointer: point.nullable(),
  warnings: z.array(z.string().max(1024)).max(32),
});
const requestSchema = z.object({
  model: z.string().min(1).max(256), instructions: z.string().max(65_536), store: z.literal(false),
  max_output_tokens: z.number().int().positive().max(32_768),
  input: z.array(z.object({ role: z.literal('user'), content: z.array(z.union([
    z.object({ type: z.literal('input_text'), text: z.string().max(1024 * 1024) }),
    z.object({ type: z.literal('input_image'), image_url: z.string().regex(/^images\/[A-Za-z0-9_-]{1,128}-(clean|trail)\.jpg$/), detail: z.literal('high') }),
  ])).max(64) })).max(1),
});
const resultSchema = z.object({
  status: z.enum(['completed', 'cancelled', 'failed', 'interrupted']), response: z.string().max(65_536).optional(),
  error: z.object({ component: z.string().max(128).optional(), code: z.string().max(128).optional(), message: z.string().max(4096).optional() }).optional(),
  latency: z.record(z.string().max(128), z.number().finite().optional()).optional(),
});
const reserved = /^(?:api.?key(?:env)?|secret|credential.*|authorization|auth|headers?|environment|env|raw.?audio|audio.?data|pcm|token|access.?token|refresh.?token|password|cookie|stack|cause)$/i;
const eventFields = new Set(['state', 'phase', 'code', 'message', 'status', 'provider', 'model', 'durationMs', 'elapsedMs',
  'atMs', 'receivedAtMs', 'bytes', 'samples', 'startSample', 'endSample', 'sampleRate', 'timing', 'count', 'frames',
  'frameCount', 'contextCount', 'cursorCount', 'phraseCount', 'textLength', 'boundary', 'attempt', 'httpStatus', 'reason', 'size',
  'kind', 'phraseId', 'startMs', 'endMs', 'characters', 'trailCopies', 'requestId', 'capability', 'platform', 'session',
  'speechModel', 'reasoningModel', 'speechKeyPresent', 'reasoningKeyPresent', 'phrases']);
const pendingLimit = 32 * 1024 * 1024;
const audioFields = new Set(['sampleRate', 'samples', 'durationMs', 'firstCapturedAtMs', 'lastCapturedAtMs', 'firstReceivedAtMs', 'maxDeliveryLagMs', 'timing']);
type File = { name: string; data: Buffer | string };
type Job = { bytes: number; run: () => Promise<void> };

function pick(value: object, keys: string[]) {
  const source = value as Record<string, unknown>;
  return Object.fromEntries(keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
}

function redactSecrets(text: string, secrets: string[]): string {
  for (const secret of secrets) text = text.split(secret).join('[REDACTED]');
  return text;
}

function redact(value: unknown, secrets: string[], depth = 0, parent = ''): unknown {
  if (depth > 24) return '[omitted: depth limit]';
  if (parent.toLowerCase() === 'audio' && (!value || typeof value !== 'object' || Array.isArray(value))) return '[omitted: raw audio]';
  if (typeof value === 'string') {
    const first = value.trimStart()[0];
    if (first === '[' || first === '{') {
      try { return JSON.stringify(redact(JSON.parse(value), secrets, depth + 1, parent)); } catch { /* Ordinary text. */ }
    }
    if (/^data:[^;]+;base64,/i.test(value) || /^[A-Za-z0-9+/]{128,}={0,2}$/.test(value)) return '[omitted: binary data]';
    return redactSecrets(value, secrets);
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets, depth + 1, parent));
  if (value && typeof value === 'object') {
    if (value instanceof Error || ArrayBuffer.isView(value)) return '[omitted]';
    return Object.fromEntries(Object.entries(value).filter(([key]) => !reserved.test(key)
      && !(key === 'data' && /^(image|audio)$/i.test(parent)) && (parent.toLowerCase() !== 'audio' || audioFields.has(key)))
      .map(([key, item]) => [redactSecrets(key, secrets), redact(item, secrets, depth + 1, key)]));
  }
  return value;
}

function imageBytes(image: ScreenFrameCapture['image']): Buffer {
  const parsed = screenFrameCaptureSchema.shape.image.parse(image);
  const bytes = Buffer.from(parsed.data, 'base64');
  if (bytes.length > 1_000_000 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff
    || bytes.toString('base64') !== parsed.data) throw new Error('Invalid debug image.');
  return bytes;
}

function snapshotInput(input: DebugTurnInput) {
  const { history, visual } = input;
  if (history.frames.length > 12 || history.contexts.length > 24 || history.cursor.length > 1500 || history.transcript.length > 512
    || input.transcript.length > 65_536 || (visual && visual.frames.length !== history.frames.length)) throw new Error('Debug input limit exceeded.');
  const views = new Map(visual?.frames.map((view) => [view.context.frameId, view]));
  const ids = new Set<string>(); const images: File[] = [];
  let cleanBytes = 0, trailBytes = 0;
  const frames = history.frames.map((frame) => {
    const id = identifier.parse(frame.id);
    if (ids.has(id)) throw new Error('Duplicate debug frame.');
    ids.add(id);
    const cleanFile = `images/${id}-clean.jpg`;
    images.push({ name: cleanFile, data: imageBytes(frame.image) }); cleanBytes += frame.image.data.length;
    const view = views.get(id);
    if (visual && (!view || views.size !== visual.frames.length)) throw new Error('Missing debug alignment.');
    if (view?.image) {
      if (view.image.width !== frame.image.width || view.image.height !== frame.image.height) throw new Error('Mismatched debug image dimensions.');
      images.push({ name: `images/${id}-trail.jpg`, data: imageBytes(view.image) }); trailBytes += view.image.data.length;
    }
    return { id, capturedAt: screenFrameCaptureSchema.shape.capturedAt.parse(frame.capturedAt),
      atMs: time.parse(frame.atMs), receivedAtMs: time.parse(frame.receivedAtMs),
      display: screenFrameCaptureSchema.shape.display.parse(frame.display), warnings: frame.warnings,
      image: { mimeType: 'image/jpeg', width: frame.image.width, height: frame.image.height, file: cleanFile } };
  });
  if (cleanBytes > 8_000_000 || trailBytes > 8_000_000) throw new Error('Debug image limit exceeded.');
  const window = (value: NonNullable<DebugTurnInput['history']['contexts'][number]['context']['activeWindow']> | null) => value ? pick(value, ['id', 'application', 'title']) : null;
  const contexts = history.contexts.map(({ id, atMs, receivedAtMs, context }) => ({ id, atMs, receivedAtMs, context: {
    ...pick(context, ['platform', 'capturedAt', 'selectedText', 'warnings']), activeWindow: window(context.activeWindow),
    ...(context.pointer ? { pointer: { ...pick(context.pointer, ['x', 'y']), window: window(context.pointer.window) } } : {}),
  } }));
  const metadata = { transcript: input.transcript, attention: { frames, contexts,
    cursor: history.cursor.map((sample) => pick(sample, ['atMs', 'receivedAtMs', 'x', 'y', 'displayId'])),
    transcript: history.transcript.map((phrase) => pick(phrase, ['id', 'text', 'startSample', 'endSample', 'boundary', 'startMs', 'endMs', 'timing', 'receivedAtMs'])),
    durationMs: history.durationMs, warnings: history.warnings,
    audio: pick(history.audio, ['sampleRate', 'samples', 'durationMs', 'firstCapturedAtMs', 'lastCapturedAtMs', 'firstReceivedAtMs', 'maxDeliveryLagMs', 'timing']),
  }, ...(visual ? { visualContext: { warnings: visual.warnings, frames: visual.frames.map(({ context, image }) => ({
    ...alignmentSchema.parse(context), trailFile: image ? `images/${context.frameId}-trail.jpg` : null,
  })) } } : {}) };
  return { metadata, images };
}

export async function createDebugSession(rootDirectory: string, options: { secrets?: string[]; onWarning?: (message: string) => void } = {}): Promise<DebugSession> {
  if (!rootDirectory.trim() || rootDirectory.includes('\0')) throw new Error('Choose a valid debug directory.');
  const root = resolve(rootDirectory), abort = new AbortController();
  let directory: string | undefined;
  const setup = (async () => {
    try {
      await mkdir(root, { recursive: true, mode: 0o700 }); abort.signal.throwIfAborted();
      directory = await mkdtemp(join(root, `${new Date().toISOString().replace(/[:.]/g, '-')}-`)); abort.signal.throwIfAborted();
      await mkdir(join(directory, 'turns'), { mode: 0o700 }); abort.signal.throwIfAborted();
      await writeFile(join(directory, 'session.jsonl'), '', { flag: 'wx', mode: 0o600, signal: abort.signal }); abort.signal.throwIfAborted();
      return directory;
    } catch (error) {
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  })();
  let timer: NodeJS.Timeout | undefined;
  try {
    directory = await Promise.race([setup, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { abort.abort(); reject(new Error('Debug setup timed out.')); }, 2000);
    })]);
  } catch { abort.abort(); throw new Error('Could not create debug session. Check the directory and available disk space.'); }
  finally { clearTimeout(timer); }
  return session(directory, options);
}

function session(directory: string, options: { secrets?: string[]; onWarning?: (message: string) => void }): DebugSession {
  const started = performance.now(), abort = new AbortController();
  const secrets = [...new Set(options.secrets?.filter(Boolean))].sort((a, b) => b.length - a.length);
  const queue: Job[] = [], records = new Set<string>(), temporary = new Set<string>();
  let accepting = true, disabled = false, warned = false, pendingBytes = 0, logBytes = 0, events = 0;
  let draining: Promise<void> | undefined, closing: Promise<void> | undefined;
  const warning = () => {
    if (warned) return; warned = true;
    try { options.onWarning?.('Debug export is incomplete. Check disk space, permissions, and debug files; voice continues.'); } catch { /* A diagnostic cannot fail voice. */ }
  };
  const disable = () => { disabled = true; queue.splice(0).forEach((job) => { pendingBytes -= job.bytes; }); warning(); };
  const startDrain = () => {
    if (!draining) draining = (async () => {
      await Promise.resolve();
      while (queue.length && !abort.signal.aborted) {
        const next = queue.shift()!;
        try { await next.run(); } catch { disable(); }
        finally { pendingBytes -= next.bytes; }
      }
    })().finally(() => {
      draining = undefined;
      // An enqueue can land between the loop's exit and this continuation.
      if (queue.length && !disabled && !abort.signal.aborted) startDrain();
    });
  };
  const enqueue = (job: Job) => {
    if (!accepting || disabled) return;
    if (pendingBytes + job.bytes > pendingLimit) { disable(); return; }
    queue.push(job); pendingBytes += job.bytes;
    startDrain();
  };
  const turnDirectory = (turnId: string) => join(directory, 'turns', identifier.parse(turnId));
  const json = (value: unknown, limit = 2 * 1024 * 1024) => {
    const text = `${JSON.stringify(redact(value, secrets), null, 2)}\n`;
    if (Buffer.byteLength(text) > limit) throw new Error('Debug metadata limit exceeded.');
    return text;
  };
  const atomic = async (path: string, data: Buffer | string) => {
    abort.signal.throwIfAborted();
    const temp = `${path}.${randomUUID()}.tmp`; temporary.add(temp);
    try {
      await writeFile(temp, data, { flag: 'wx', mode: 0o600, signal: abort.signal }); abort.signal.throwIfAborted();
      // Publish atomically without replacing any existing file, even if another
      // process created it after the record was queued. Both paths share a volume.
      await link(temp, path);
    } finally { await rm(temp, { force: true }).catch(warning); temporary.delete(temp); }
  };
  const record = (turnId: string, name: string, prepare: () => File[]) => {
    if (!accepting || disabled) return;
    try {
      const path = turnDirectory(turnId), key = `${turnId}/${name}`;
      if (records.has(key)) { warning(); return; }
      const files = prepare();
      records.add(key);
      enqueue({ bytes: files.reduce((sum, file) => sum + Buffer.byteLength(file.data), 0), run: async () => {
        await mkdir(path, { recursive: true, mode: 0o700 }); abort.signal.throwIfAborted();
        if (files.some((file) => file.name.startsWith('images/'))) await mkdir(join(path, 'images'), { recursive: true, mode: 0o700 });
        for (const file of files) await atomic(join(path, file.name), file.data);
      } });
    } catch { warning(); }
  };
  return {
    directory, turnDirectory,
    event: (event) => {
      if (!accepting || disabled) return;
      try {
        if (!['session', 'desktop', 'speech', 'reasoning', 'runtime'].includes(event.component) || !/^[A-Za-z0-9_.:-]{1,128}$/.test(event.event)) throw new Error('Invalid diagnostic event.');
        if (event.turnId) identifier.parse(event.turnId);
        const data = Object.fromEntries(Object.entries(event.data ?? {}).filter(([key, value]) => eventFields.has(key) && !reserved.test(key)
          && (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)
            || typeof value === 'string' && value.length <= 4096 && !/^[A-Za-z0-9+/]{128,}={0,2}$/.test(value))));
        const line = `${JSON.stringify(redact({ at: new Date().toISOString(), elapsedMs: Math.round(performance.now() - started),
          ...(event.turnId ? { turnId: event.turnId } : {}), component: event.component, event: event.event, data }, secrets))}\n`;
        const bytes = Buffer.byteLength(line);
        if (++events > 10_000 || logBytes + bytes > 8 * 1024 * 1024) { disable(); return; }
        logBytes += bytes;
        enqueue({ bytes, run: () => writeFile(join(directory, 'session.jsonl'), line, { flag: 'a', mode: 0o600, signal: abort.signal }) });
      } catch { warning(); }
    },
    input: (turnId, input) => record(turnId, 'context', () => {
      const { metadata, images } = snapshotInput(input);
      return [...images, { name: 'context.json', data: json(metadata) }];
    }),
    request: (turnId, request: PreparedReasoningRequest) => record(turnId, 'request', () => [{ name: 'request.json', data: json(requestSchema.parse(request)) }]),
    result: (turnId, result) => record(turnId, 'result', () => [{ name: 'result.json', data: json(resultSchema.parse(result)) }]),
    close: () => closing ??= (async () => {
      accepting = false;
      let timer: NodeJS.Timeout | undefined;
      try {
        const flush = async () => { while (draining) await draining; };
        await Promise.race([flush(), new Promise<void>((resolve) => { timer = setTimeout(() => {
          abort.abort(); disable();
          for (const temp of temporary) void rm(temp, { force: true }).catch(warning);
          resolve();
        }, 2000); })]);
      } finally { clearTimeout(timer); }
    })(),
  };
}
