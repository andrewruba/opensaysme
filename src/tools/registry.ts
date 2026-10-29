import { z } from 'zod';
import type { ToolDefinition, ToolDescriptor, ToolHost, ToolResult } from './types.js';

const toolName = /^[a-z][a-z0-9_]{0,63}$/;
const resultSchema = z.object({
  content: z.array(z.discriminatedUnion('type', [
    z.object({ type: z.literal('text'), text: z.string().max(512 * 1024) }).strict(),
    z.object({ type: z.literal('image'), mimeType: z.literal('image/jpeg'),
      data: z.string().min(4).max(1_400_000).regex(/^[A-Za-z0-9+/]+={0,2}$/) }).strict(),
  ])).min(1).max(8),
  isError: z.boolean().optional(),
}).strict();

export function toolError(code: string, message: string): ToolResult {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code, message }) }] };
}

export function validateToolResult(raw: unknown): ToolResult {
  const result = resultSchema.parse(raw);
  let textBytes = 0;
  for (const part of result.content) {
    if (part.type === 'text') textBytes += Buffer.byteLength(part.text);
    else {
      const bytes = Buffer.from(part.data, 'base64');
      if (bytes.length > 1_000_000 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff
        || bytes.toString('base64') !== part.data) throw new Error('Invalid tool image.');
    }
  }
  if (textBytes > 512 * 1024 || Buffer.byteLength(JSON.stringify(result)) > 2 * 1024 * 1024) throw new Error('Oversized tool result.');
  return result;
}

function cancelled(): Error { return new DOMException('Tool call cancelled.', 'AbortError'); }

/** Validated local capabilities, independent of the reasoning provider. */
export class ToolRegistry implements ToolHost {
  private readonly tools = new Map<string, { definition: ToolDefinition; descriptor: ToolDescriptor }>();
  private operation?: AbortController;
  private closed = false;
  private readonly timeoutMs: number;

  constructor(definitions: ToolDefinition[], options: { timeoutMs?: number } = {}) {
    this.timeoutMs = options.timeoutMs ?? 6_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60_000
      || definitions.length > 32) throw new Error('Invalid tool registry limits.');
    for (const definition of definitions) {
      if (!toolName.test(definition.name) || this.tools.has(definition.name)
        || !definition.description.trim() || definition.description.length > 4096
        || !['read', 'focus'].includes(definition.effect) || !(definition.input instanceof z.ZodObject)) {
        throw new Error('Invalid or duplicate tool definition.');
      }
      const input = definition.input.strict();
      const inputSchema = z.toJSONSchema(input);
      delete inputSchema.$schema;
      inputSchema.required ??= [];
      if (inputSchema.type !== 'object' || inputSchema.additionalProperties !== false
        || Object.keys(inputSchema.properties ?? {}).length !== (inputSchema.required?.length ?? 0)) {
        throw new Error('Tool inputs must be strict objects with required properties.');
      }
      this.tools.set(definition.name, { definition: { ...definition, input }, descriptor: {
        name: definition.name, description: definition.description, effect: definition.effect, inputSchema,
      } });
    }
  }

  list(): ToolDescriptor[] {
    return this.closed ? [] : [...this.tools.values()].map(({ descriptor }) => structuredClone(descriptor));
  }

  async call(name: string, args: unknown, signal: AbortSignal): Promise<ToolResult> {
    if (signal.aborted) throw cancelled();
    if (this.closed) return toolError('closed', 'This tool session has ended.');
    const entry = this.tools.get(name);
    if (!entry) return toolError('unknown-tool', 'That tool is not available. Use the advertised tool catalog.');
    if (this.operation) return toolError('busy', 'Another desktop tool is still running.');
    let parsed: z.ZodSafeParseResult<Record<string, unknown>>;
    try {
      if (Buffer.byteLength(JSON.stringify(args) ?? '') > 65_536) throw new Error();
      parsed = entry.definition.input.safeParse(args);
    } catch { return toolError('invalid-arguments', 'The tool arguments are invalid or too large.'); }
    if (!parsed.success) return toolError('invalid-arguments', 'The tool arguments do not match its input schema.');

    const operation = new AbortController();
    this.operation = operation;
    const abort = () => operation.abort();
    signal.addEventListener('abort', abort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; operation.abort(); }, this.timeoutMs);
    let onAbort: () => void = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(cancelled());
      operation.signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      const work = Promise.resolve().then(() => {
        operation.signal.throwIfAborted();
        return entry.definition.run(parsed.data!, operation.signal);
      });
      const raw = await Promise.race([work, aborted]);
      operation.signal.throwIfAborted();
      return validateToolResult(raw);
    } catch {
      if (signal.aborted || this.closed) throw cancelled();
      return timedOut ? toolError('timeout', 'The tool timed out. Check desktop access before retrying.')
        : toolError('tool-failed', 'The tool could not complete or returned invalid data. Run opensaysme doctor and check desktop permissions.');
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      operation.signal.removeEventListener('abort', onAbort);
      if (this.operation === operation) this.operation = undefined;
    }
  }

  close(): void {
    this.closed = true;
    this.operation?.abort();
    this.tools.clear();
  }
}
