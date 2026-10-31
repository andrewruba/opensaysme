import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { configPath } from './config.js';
import { isWellFormedText, isTextBoundary } from './desktop/text-types.js';

export const workContextLifetimeMs = 8 * 60 * 60 * 1000;
const maxEntries = 12;
const maxFileBytes = 64 * 1024;
const refreshIntervalMs = 60_000;
const label = (limit: number) => z.string().max(limit)
  .refine((value) => value.length <= limit && isWellFormedText(value), 'Invalid work-context label.');
const referenceSchema = z.object({
  application: label(256).refine((value) => value.trim().length > 0),
  title: label(512).optional(), observedAt: z.string().datetime(),
}).strict();
export type WorkReference = z.infer<typeof referenceSchema>;
const key = ({ application, title }: Pick<WorkReference, 'application' | 'title'>) => JSON.stringify([application, title ?? null]);
export const workContextSchema = z.array(referenceSchema).max(maxEntries)
  .refine((entries) => new Set(entries.map(key)).size === entries.length, 'Duplicate work-context references.');
const storedSchema = z.object({ version: z.literal(1), references: workContextSchema }).strict();

interface WorkContextOptions {
  /** Omit for in-memory context only. */
  path?: string;
  now?: () => number;
  onWarning?: (message: string) => void;
}

export function workContextPath(env = process.env): string {
  return join(dirname(configPath(env)), 'work-context.json');
}

function bounded(value: string, limit: number): string {
  let end = Math.min(value.length, limit);
  if (!isTextBoundary(value, end)) end--;
  return value.slice(0, end);
}

async function readBounded(path: string): Promise<unknown> {
  const file = await open(path, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > maxFileBytes) throw new Error('Invalid work-context file.');
    const buffer = Buffer.alloc(maxFileBytes + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > maxFileBytes) throw new Error('Oversized work-context file.');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size)));
  } finally { await file.close(); }
}

async function persist(path: string, references: WorkReference[]): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.work-context-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify({ version: 1, references })}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally {
    try { await unlink(temporary); } catch { /* Successful rename already removed it. */ }
  }
}

/** Historical labels help resolve references; they carry no native target or authority. */
export class WorkContextStore {
  private entries: WorkReference[] = [];
  private writing?: Promise<void>;
  private dirty = false;
  private closed = false;
  private persistenceFailed = false;
  private warned = false;
  private readonly now: () => number;

  private constructor(private readonly options: WorkContextOptions) { this.now = options.now ?? Date.now; }

  static async open(options: WorkContextOptions = {}): Promise<WorkContextStore> {
    const store = new WorkContextStore(options);
    if (options.path !== undefined) {
      try {
        const data = storedSchema.parse(await readBounded(options.path));
        const now = store.now();
        if (data.references.some(({ observedAt }) => Date.parse(observedAt) > now)) throw new Error('Future work-context timestamp.');
        store.entries = data.references.sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt));
        store.prune();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') store.warn();
      }
    }
    return store;
  }

  /** Most recently observed first; returned references cannot mutate this store. */
  recent(): WorkReference[] {
    if (this.closed) return [];
    this.prune();
    return structuredClone(this.entries);
  }

  observe(window: { application: string; title?: string } | null): void {
    if (this.closed) return;
    this.prune();
    if (!window || typeof window.application !== 'string' || !window.application.trim()
      || !isWellFormedText(window.application)
      || (window.title !== undefined && (typeof window.title !== 'string' || !isWellFormedText(window.title)))) return;
    // Pick only these native labels, never spread an AX control, request or tool result.
    const reference: WorkReference = {
      application: bounded(window.application, 256),
      ...(window.title === undefined ? {} : { title: bounded(window.title, 512) }),
      observedAt: new Date(this.now()).toISOString(),
    };
    if (!referenceSchema.safeParse(reference).success) return;
    const id = key(reference);
    if (this.entries[0] && key(this.entries[0]) === id
      && Date.parse(reference.observedAt) - Date.parse(this.entries[0].observedAt) < refreshIntervalMs) return;
    this.entries = [reference, ...this.entries.filter((entry) => key(entry) !== id)].slice(0, maxEntries);
    this.queueWrite();
  }

  /** Stop accepting observations, flush the latest bounded state, then release memory. */
  async close(): Promise<void> {
    if (!this.closed) { this.prune(); this.closed = true; }
    while (this.writing) await this.writing;
    this.entries = [];
  }

  private prune(): void {
    const now = this.now();
    const remaining = this.entries.filter(({ observedAt }) => {
      const age = now - Date.parse(observedAt);
      return age >= 0 && age < workContextLifetimeMs;
    });
    if (remaining.length === this.entries.length) return;
    this.entries = remaining;
    this.queueWrite();
  }

  private queueWrite(): void {
    if (this.options.path === undefined || this.persistenceFailed) return;
    this.dirty = true;
    if (this.writing) return;
    this.writing = this.writePending().finally(() => {
      this.writing = undefined;
      if (this.dirty) this.queueWrite();
    });
  }

  private async writePending(): Promise<void> {
    while (this.dirty) {
      this.dirty = false;
      const references = structuredClone(this.entries);
      try { await persist(this.options.path!, references); }
      catch {
        this.dirty = false;
        this.persistenceFailed = true;
        this.warn();
      }
    }
  }

  private warn(): void {
    if (this.warned) return;
    this.warned = true;
    try { this.options.onWarning?.('Saved work context is unavailable. Current-session context can still be used.'); }
    catch { /* Optional feedback cannot stop context collection. */ }
  }
}

export const openWorkContext = (options: WorkContextOptions = {}): Promise<WorkContextStore> => WorkContextStore.open(options);

/** Stop voice mode before clearing so an active store cannot recreate the file. */
export async function clearWorkContext(path = workContextPath()): Promise<void> {
  try { await unlink(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      // Filesystem errors can contain private paths; callers receive only a safe message.
      // eslint-disable-next-line preserve-caught-error
      throw new Error('Could not clear saved work context.');
    }
  }
}
