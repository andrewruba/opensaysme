import { describe, expect, it, vi } from 'vitest';
import type { AttentionHistory } from '../src/attention.js';
import type { DiagnosticEvent, PreparedReasoningRequest } from '../src/diagnostics.js';
import { openAIReasoning } from '../src/reasoning/openai.js';
import type { RequestStrategy } from '../src/reasoning/strategy.js';
import type { ReasoningInput } from '../src/reasoning/types.js';
import type { ToolDescriptor, ToolEvent, ToolHost } from '../src/tools/types.js';

const strategy = (kind: RequestStrategy['kind'], execution: RequestStrategy['execution'], goal: string,
  question: string | null = null): RequestStrategy => ({ kind, execution, goal, question });
const output = (...items: unknown[]) => Response.json({ status: 'completed', output: items });
const call = (route: unknown, name: string, args: unknown = {}, id = 'call-1') => output({
  type: 'function_call', name, call_id: id, arguments: JSON.stringify({ strategy: route, arguments: args }),
});
const answer = (route: unknown, response: string) => output({ type: 'message', role: 'assistant', status: 'completed',
  content: [{ type: 'output_text', text: JSON.stringify({ strategy: route, response }) }],
});
const descriptor = (name: string, effect: ToolDescriptor['effect'], properties: Record<string, unknown>): ToolDescriptor => ({
  name, effect, description: `Fixture for ${name}.`, inputSchema: { type: 'object', properties,
    required: Object.keys(properties), additionalProperties: false },
});
const descriptors = [
  descriptor('list_windows', 'read', {}),
  descriptor('inspect_window', 'read', { windowId: { type: 'string' } }),
  descriptor('type_text', 'input', { observationId: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, text: { type: 'string' } }),
  descriptor('press_key', 'input', { keyboardObservationId: { type: 'string' }, key: { type: 'string' }, modifiers: { type: 'array', items: { type: 'string' } } }),
];

function fixture(fetcher: ReturnType<typeof vi.fn<typeof fetch>>, transcript: string, selectedText = 'User-selected source.') {
  const history: AttentionHistory = { durationMs: 1000, frames: [], cursor: [], transcript: [], warnings: [],
    audio: { sampleRate: 24000, samples: 24000, durationMs: 1000, firstCapturedAtMs: 0,
      lastCapturedAtMs: 1000, firstReceivedAtMs: 0, maxDeliveryLagMs: 0, timing: 'device' },
    contexts: [{ id: 'source-context', atMs: 0, receivedAtMs: 0, context: {
      platform: 'darwin', capturedAt: '2026-11-01T12:00:00Z', warnings: [], selectedText,
      activeWindow: { id: 'source-native', application: 'Workspace', title: 'Source material' },
    } }],
  };
  const host = { list: vi.fn(() => structuredClone(descriptors)),
    call: vi.fn<ToolHost['call']>(async () => ({ content: [{ type: 'text', text: 'Fixture observation.' }] })), close: vi.fn(),
  } satisfies ToolHost;
  const requests: PreparedReasoningRequest[] = [];
  const diagnostics: DiagnosticEvent[] = [];
  const events: ToolEvent[] = [];
  const input: ReasoningInput = { transcript, history, visual: { frames: [], warnings: [] }, tools: host,
    signal: new AbortController().signal, onRequest: (request) => requests.push(request),
    onDiagnostic: (event) => diagnostics.push(event), onTool: (event) => events.push(event),
  };
  const reason = openAIReasoning({ apiKey: 'fixture-key', model: 'fixture-model' }, fetcher);
  return { reason, input, host, requests, diagnostics, events, fetcher };
}

// Provider decisions are scripted: these exercise execution routing and handoff transport,
// not whether a live model chooses the appropriate executor on an arbitrary request.
describe('direct handling and delegation', () => {
  it.each([
    ['developer', 'Fix this build failure. Do not deploy.', 'Build failed: generated schema is missing.', 'Do not deploy.'],
    ['general', 'Research these options and create a comparison. Do not contact vendors.', 'Options: Cedar, Maple, Birch.', 'Do not contact vendors.'],
    ['general', 'Create a presentation from these notes. Keep it internal.', 'Notes: migration timeline and adoption goals.', 'Keep it internal.'],
  ] as const)('carries a substantive %s request through a bounded existing-tool handoff', async (kind, request, selected, constraint) => {
    const route = strategy(kind, 'delegate', request, 'Which observed agent workspace is connected to this task?');
    const write = { observationId: 'fresh-composer', x: 100, y: 100,
      text: `${request}\nSelected source: ${selected}\nAdditional evidence: details in the source window.\nCause and final outcome are not yet verified.` };
    const send = { keyboardObservationId: 'fresh-keyboard', key: 'Enter', modifiers: [] };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(call(route, 'list_windows'))
      .mockResolvedValueOnce(call(route, 'inspect_window', { windowId: 'source' }, 'source'))
      .mockResolvedValueOnce(call(route, 'inspect_window', { windowId: 'agent' }, 'destination'))
      .mockResolvedValueOnce(call({ ...route, question: null }, 'type_text', write, 'prepare'))
      .mockResolvedValueOnce(call({ ...route, question: null }, 'press_key', send, 'send'))
      .mockResolvedValueOnce(call({ ...route, question: 'Was the request received?' }, 'inspect_window', { windowId: 'agent' }, 'receipt'))
      .mockResolvedValueOnce(answer({ ...route, question: null }, 'The agent received the request. The work is not yet verified complete.'));
    const f = fixture(fetcher, request, selected);
    const values = ['Source and related agent windows discovered.', 'Details in the source window.',
      'The agent workspace is connected to the selected task.', 'Draft verified.', 'Submit issued; completion unknown.', 'The submitted request is visible in the agent conversation.'];
    for (const value of values) f.host.call.mockResolvedValueOnce({ content: [{ type: 'text', text: value }] });
    await expect(f.reason(f.input)).resolves.toBe('The agent received the request. The work is not yet verified complete.');
    expect(fetcher).toHaveBeenCalledTimes(7);
    expect(f.host.call.mock.calls.map(([name, args]) => [name, args])).toEqual([
      ['list_windows', {}], ['inspect_window', { windowId: 'source' }], ['inspect_window', { windowId: 'agent' }],
      ['type_text', write], ['press_key', send], ['inspect_window', { windowId: 'agent' }],
    ]);
    for (const prepared of f.requests) {
      const metadata = JSON.parse((prepared.input[0]!.content as Array<{ text: string }>)[0]!.text);
      expect(metadata.transcript).toBe(request);
      expect(metadata.attention.contexts[0].context.selectedText).toBe(selected);
      expect(prepared.tools?.map(({ name }) => name)).toEqual(descriptors.map(({ name }) => name));
    }
    expect(write.text).toContain(constraint);
    expect(f.requests[1]!.instructions).toContain(`## Current strategy: ${kind}`);
    expect(f.requests[1]!.instructions).toContain('## Current execution: delegate');
    expect(JSON.stringify(f.events)).not.toContain('"execution"');
    expect(JSON.stringify(f.requests.at(-1)!.input)).toContain('The submitted request is visible');
  });

  it.each([
    ['developer', 'Explain this command.', 'git diff --stat', 'It summarizes the changed files.'],
    ['general', 'Summarize this selected paragraph in one sentence.', 'The release adds a faster search experience.', 'The release makes search faster.'],
  ] as const)('answers a simple %s request directly without a routing or delegation call', async (kind, request, selected, text) => {
    const route = strategy(kind, 'direct', request);
    const f = fixture(vi.fn<typeof fetch>().mockResolvedValue(answer(route, text)), request, selected);
    await expect(f.reason(f.input)).resolves.toBe(text);
    expect(f.fetcher).toHaveBeenCalledOnce();
    expect(f.host.call).not.toHaveBeenCalled();
    const wire = JSON.parse(JSON.stringify(f.requests[0]));
    const routeSchema = wire.text.format.schema.properties.strategy;
    expect(routeSchema.required).toEqual(expect.arrayContaining(['kind', 'execution']));
    expect(routeSchema.properties.kind.enum).toEqual(['developer', 'general']);
    expect(routeSchema.properties.execution.enum).toEqual(['direct', 'delegate']);
    for (const tool of wire.tools) expect(tool.parameters.properties.strategy).toEqual(routeSchema);
    expect(f.diagnostics.filter(({ event }) => event === 'strategy-selected')).toMatchObject([
      { data: { kind, execution: 'direct', changed: false } },
    ]);
  });

  it('retains a direct user instruction and forwards only the requested simple edit', async () => {
    const request = 'Change this heading to Quarterly review yourself. Do not delegate or send it.';
    const route = strategy('general', 'direct', request);
    const args = { observationId: 'fresh-heading', x: 20, y: 30, text: 'Quarterly review' };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(call(route, 'type_text', args))
      .mockResolvedValueOnce(answer(route, 'Changed the heading.'));
    const f = fixture(fetcher, request, 'Draft heading');
    await expect(f.reason(f.input)).resolves.toBe('Changed the heading.');
    expect(f.host.call).toHaveBeenCalledExactlyOnceWith('type_text', args, expect.any(AbortSignal));
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(f.requests[1]!.instructions).toContain('## Current execution: direct');
    expect(JSON.stringify(f.requests[1]!.input[0])).toContain(request);
  });

  it('revises execution without changing the developer strategy or discarding observations', async () => {
    const first = strategy('developer', 'direct', 'Explain this failure.', 'Is the supplied error sufficient?');
    const revised = strategy('developer', 'delegate', 'Investigate the failure across the project.', 'Which existing agent can inspect this project?');
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(call(first, 'inspect_window', { windowId: 'source' }))
      .mockResolvedValueOnce(call(revised, 'list_windows', {}, 'discover'))
      .mockResolvedValueOnce(answer(revised, 'Which of these two agent workspaces should handle this project?'));
    const f = fixture(fetcher, 'Find why this fails and fix it.');
    f.host.call.mockResolvedValueOnce({ content: [{ type: 'text', text: 'Failure crosses several services; only one stack trace is visible.' }] });
    await f.reason(f.input);
    expect(f.requests[1]!.instructions).toContain('## Current execution: direct');
    expect(f.requests[2]!.instructions).toContain('## Current execution: delegate');
    expect(f.requests[2]!.instructions).toContain('## Current strategy: developer');
    expect(JSON.stringify(f.requests[2]!.input)).toContain('Failure crosses several services');
    expect(f.diagnostics.filter(({ event }) => event === 'strategy-selected').map(({ data }) => data)).toEqual([
      { kind: 'developer', execution: 'direct', changed: false },
      { kind: 'developer', execution: 'delegate', changed: true },
      { kind: 'developer', execution: 'delegate', changed: false },
    ]);
  });

  it('can ask about an unavailable executor without switching into unsupported substantive execution', async () => {
    const request = 'Research these suppliers and prepare a recommendation.';
    const route = strategy('general', 'delegate', request, 'Where is the appropriate research agent?');
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(call(route, 'list_windows'))
      .mockResolvedValueOnce(answer(route, 'I could not identify a research workspace. Which agent should receive this?'));
    const f = fixture(fetcher, request);
    f.host.call.mockResolvedValueOnce({ content: [{ type: 'text', text: 'Only the source document is available; no destination could be inspected.' }] });
    await expect(f.reason(f.input)).resolves.toContain('Which agent');
    expect(f.host.call).toHaveBeenCalledExactlyOnceWith('list_windows', {}, expect.any(AbortSignal));
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(f.requests[1]!.instructions).toContain('## Current execution: delegate');
  });

  it.each([undefined, null, 'automatic', 'DIRECT', { approved: true }])('rejects invalid execution metadata before tool dispatch: %j', async (execution) => {
    const route = { kind: 'developer', execution, goal: 'Fix this.', question: null };
    const f = fixture(vi.fn<typeof fetch>().mockResolvedValue(call(route, 'type_text', { text: 'private data' })), 'Fix this.');
    await expect(f.reason(f.input)).rejects.toThrow('valid reasoning response');
    expect(f.host.call).not.toHaveBeenCalled();
    expect(f.events).toEqual([]);
    expect(f.diagnostics.some(({ event }) => event === 'strategy-selected')).toBe(false);
    expect(JSON.stringify(f.diagnostics)).not.toContain('private data');
  });

  it('rejects a missing execution choice in a direct answer', async () => {
    const f = fixture(vi.fn<typeof fetch>().mockResolvedValue(answer({ kind: 'general', goal: 'Answer.', question: null }, 'private answer')), 'Explain this.');
    await expect(f.reason(f.input)).rejects.not.toThrow(/private answer/);
    expect(f.diagnostics.some(({ event }) => event === 'strategy-selected')).toBe(false);
  });
});
