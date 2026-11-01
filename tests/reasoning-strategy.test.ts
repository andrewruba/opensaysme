import { describe, expect, it, vi } from 'vitest';
import type { AttentionHistory } from '../src/attention.js';
import type { DiagnosticEvent, PreparedReasoningRequest } from '../src/diagnostics.js';
import { openAIReasoning } from '../src/reasoning/openai.js';
import type { RequestStrategy } from '../src/reasoning/strategy.js';
import type { ReasoningInput } from '../src/reasoning/types.js';
import { createInputTools } from '../src/tools/input.js';
import type { ActionAuthorizer } from '../src/tools/permissions.js';
import { ToolRegistry } from '../src/tools/registry.js';
import type { ToolDescriptor, ToolEvent, ToolHost } from '../src/tools/types.js';

const route = (kind: RequestStrategy['kind'], goal: string, question: string | null = null): RequestStrategy => ({ kind, execution: 'direct', goal, question });
const developer = route('developer', 'Explain the selected command.');
const general = route('general', 'Shorten the selected paragraph without sending it.');
const result = (...output: unknown[]) => Response.json({ status: 'completed', output });
const message = (value: unknown) => ({ type: 'message', role: 'assistant', status: 'completed',
  content: [{ type: 'output_text', text: JSON.stringify(value) }] });
const answer = (strategy: unknown, response = 'Done.') => result(message({ strategy, response }));
const toolCall = (strategy: unknown, name = 'list_windows', args: unknown = {}, id = 'call-1') => ({
  type: 'function_call', status: 'completed', call_id: id, name, arguments: JSON.stringify({ strategy, arguments: args }),
});

const descriptors: ToolDescriptor[] = [
  { name: 'list_windows', description: 'Discover current windows.', effect: 'read', inputSchema: {
    type: 'object', properties: {}, required: [], additionalProperties: false,
  } },
  { name: 'capture_text', description: 'Read the focused text control.', effect: 'read', inputSchema: {
    type: 'object', properties: {}, required: [], additionalProperties: false,
  } },
  { name: 'inspect_window', description: 'Read a discovered window.', effect: 'read', inputSchema: {
    type: 'object', properties: { windowId: { type: 'string' } }, required: ['windowId'], additionalProperties: false,
  } },
  { name: 'type_text', description: 'Replace a focused input under the existing action checks.', effect: 'input', inputSchema: {
    type: 'object', properties: { observationId: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, text: { type: 'string' } },
    required: ['observationId', 'x', 'y', 'text'], additionalProperties: false,
  } },
];

function fixture(fetcher = vi.fn<typeof fetch>(), transcript = 'What does this command do?', selectedText = 'git diff --stat') {
  const controller = new AbortController();
  const history: AttentionHistory = { durationMs: 1000, frames: [], cursor: [], transcript: [], warnings: [],
    audio: { sampleRate: 24000, samples: 24000, durationMs: 1000, firstCapturedAtMs: 0,
      lastCapturedAtMs: 1000, firstReceivedAtMs: 0, maxDeliveryLagMs: 0, timing: 'device' },
    contexts: [{ id: 'context-command', atMs: 0, receivedAtMs: 0, context: {
      platform: 'darwin', capturedAt: '2026-11-01T12:00:00Z', warnings: [], selectedText,
      activeWindow: { id: 'terminal-native', application: 'Terminal', title: 'project' },
    } }],
  };
  const host = { list: vi.fn(() => structuredClone(descriptors)),
    call: vi.fn<ToolHost['call']>(async () => ({ content: [{ type: 'text', text: 'Observed fixture content.' }] })),
    close: vi.fn(),
  } satisfies ToolHost;
  const diagnostics: DiagnosticEvent[] = [];
  const events: ToolEvent[] = [];
  const requests: PreparedReasoningRequest[] = [];
  const input: ReasoningInput = { transcript, history, visual: { frames: [], warnings: [] }, tools: host,
    signal: controller.signal, onDiagnostic: (event) => diagnostics.push(event), onTool: (event) => events.push(event),
    onRequest: (request) => requests.push(request),
  };
  const reason = openAIReasoning({ apiKey: 'fixture-key', model: 'fixture-model' }, fetcher);
  return { input, host, diagnostics, events, requests, reason, fetcher, controller };
}

// These scripted model choices test routing transport and enforcement, not model classification accuracy.
describe('developer and general strategy routing', () => {
  it('answers a selected command in one response without executing or investigating it', async () => {
    const explanation = 'It summarizes the files changed in your working tree.';
    const f = fixture(vi.fn<typeof fetch>().mockResolvedValue(answer(developer, explanation)));
    await expect(f.reason(f.input)).resolves.toBe(explanation);
    expect(f.fetcher).toHaveBeenCalledOnce();
    expect(f.host.call).not.toHaveBeenCalled();
    const metadata = JSON.parse((f.requests[0]!.input[0]!.content as Array<{ text: string }>)[0]!.text);
    expect(metadata.transcript).toBe(f.input.transcript);
    expect(metadata.attention.contexts[0].context.selectedText).toBe('git diff --stat');
    expect(f.diagnostics.filter(({ event }) => event === 'strategy-selected')).toMatchObject([
      { data: { kind: 'developer' } },
    ]);
    expect(JSON.stringify(f.diagnostics)).not.toMatch(/git diff|Explain the selected command/);
  });

  it.each([
    ['build failure', 'Why did this build fail?', 'TS2307: Cannot find module ./generated', 'capture_text', {}],
    ['configuration', 'Why is this setting ignored?', 'compilerOptions: { strict: true }', 'inspect_window', { windowId: 'config-window' }],
    ['API failure', 'Explain this failed request.', 'HTTP 422: missing field accountId', 'capture_text', {}],
    ['performance', 'Help find why this is slow.', 'Query duration: 5300ms', 'inspect_window', { windowId: 'profile-window' }],
    ['code question', 'Where is this function called?', 'function normalizeInput(value)', 'inspect_window', { windowId: 'source-window' }],
  ])('uses an existing evidence tool for a scripted %s strategy without a classifier roundtrip', async (_domain, transcript, selected, name, args) => {
    const strategy = route('developer', String(transcript), 'What does the relevant source show?');
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(result(toolCall(strategy, String(name), args)))
      .mockResolvedValueOnce(answer({ ...strategy, question: null }, 'Here is the relevant context.'));
    const f = fixture(fetcher, String(transcript), String(selected));
    await expect(f.reason(f.input)).resolves.toBe('Here is the relevant context.');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(f.host.call).toHaveBeenCalledExactlyOnceWith(name, args, expect.any(AbortSignal));
    expect(f.requests[1]!.instructions).toContain('## Current strategy: developer');
    for (const request of f.requests) expect(request.tools?.map(({ name: toolName }) => toolName)).toEqual(descriptors.map(({ name: toolName }) => toolName));
    expect(f.events.map(({ arguments: toolArguments }) => toolArguments)).toEqual([args, args]);
  });

  it('revises a route as evidence arrives while retaining the selected command, ticket and original request', async () => {
    const investigating = route('general', 'Identify what the user wants fixed.', 'What is this window showing?');
    const discovered = route('developer', 'Prepare the build failure and ticket for the agent.', 'Which project owns this failure?');
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(result(toolCall(investigating)))
      .mockResolvedValueOnce(result(toolCall(discovered, 'capture_text', {}, 'read-build')))
      .mockResolvedValueOnce(answer({ ...discovered, question: null }, 'Prepared the context and left it unsent.'));
    const f = fixture(fetcher, 'Fix this using this ticket, but leave the agent input unsent.', 'npm run build');
    f.input.history.contexts.push({ id: 'context-ticket', atMs: 500, receivedAtMs: 500, context: {
      platform: 'darwin', capturedAt: '2026-11-01T12:00:00.500Z', warnings: [], selectedText: 'Expected behavior: reject invalid account IDs.',
      activeWindow: { id: 'ticket-native', application: 'Browser', title: 'APP-42' },
    } });
    f.host.call.mockResolvedValueOnce({ content: [{ type: 'text', text: 'Found build terminal for the API project.' }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'Build failed in account.ts:42.' }] });
    await f.reason(f.input);
    expect(f.requests[1]!.instructions).toContain('## Current strategy: general');
    expect(f.requests[2]!.instructions).toContain('## Current strategy: developer');
    for (const request of f.requests) {
      const metadata = JSON.parse((request.input[0]!.content as Array<{ text: string }>)[0]!.text);
      expect(metadata.transcript).toBe(f.input.transcript);
      expect(metadata.attention.contexts).toEqual(f.input.history.contexts);
    }
    const finalInput = JSON.stringify(f.requests[2]!.input);
    expect(finalInput).toContain('Found build terminal for the API project.');
    expect(finalInput).toContain('Build failed in account.ts:42.');
    expect(f.diagnostics.filter(({ event }) => event === 'strategy-selected')[1]).toMatchObject({ data: { kind: 'developer', changed: true } });
    expect(f.host.call.mock.calls.map(([name]) => name)).toEqual(['list_windows', 'capture_text']);
  });

  it('forwards only ordinary edit arguments and preserves explicit exclusions for general work', async () => {
    const args = { observationId: 'fresh-input', x: 10, y: 20, text: 'Shorter paragraph.' };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(result(toolCall(general, 'type_text', args)))
      .mockResolvedValueOnce(answer(general, 'Shortened and left unsent.'));
    const f = fixture(fetcher, 'Shorten this paragraph. Do not send it.', 'A long paragraph.');
    await expect(f.reason(f.input)).resolves.toBe('Shortened and left unsent.');
    expect(f.host.call).toHaveBeenCalledExactlyOnceWith('type_text', args, expect.any(AbortSignal));
    expect(f.events).toMatchObject([{ arguments: args }, { arguments: args }]);
    expect(f.events.every((event) => !('strategy' in event.arguments))).toBe(true);
    expect(f.requests[1]!.instructions).toContain('## Current strategy: general');
    expect(JSON.stringify(f.requests[1]!.input[0])).toContain('Do not send it.');
  });

  it('cannot turn a strategy choice or revision into permission to submit an explicitly unsent draft', async () => {
    const request = 'Prepare the build failure for my coding agent; leave it unsent.';
    const frame = { status: 'ok' as const, window: { id: 'agent-native', application: 'Editor', title: 'Agent' },
      capturedAt: '2026-11-01T12:00:00Z', bounds: { x: 0, y: 0, width: 800, height: 600 },
      image: { mimeType: 'image/jpeg' as const, width: 800, height: 600, data: '/9j/AA==' }, warnings: [] };
    const target = { fingerprint: 'a'.repeat(64), role: 'AXButton', title: 'Send', description: '', value: '',
      bounds: { x: 0, y: 0, width: 100, height: 30 }, focused: false, editable: false };
    const execute = vi.fn(async () => ({ status: 'issued' as const }));
    const authorize = vi.fn<ActionAuthorizer>(async () => ({ decision: 'deny', effect: 'submit',
      requestQuote: 'leave it unsent', reason: 'The request excludes sending.' }));
    const inputs = createInputTools({ inspect: async () => target, execute }, { request, authorize });
    const host = new ToolRegistry(inputs.definitions);
    const developerSend = route('developer', 'Send the build failure to the agent.');
    const generalSend = route('general', 'Send the draft using the general strategy.');
    const args = () => ({ observationId: inputs.observe(frame), x: 10, y: 10 });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(result(toolCall(developerSend, 'click', args())))
      .mockImplementationOnce(async () => result(toolCall(generalSend, 'click', args(), 'retry')))
      .mockResolvedValueOnce(answer(generalSend, 'The draft remains unsent.'));
    const f = fixture(fetcher, request, 'Build failed.'); f.input.tools = host;
    try {
      await expect(f.reason(f.input)).resolves.toBe('The draft remains unsent.');
      expect(authorize).toHaveBeenCalledOnce();
      expect(authorize.mock.calls[0]![0]).toMatchObject({ request, action: { kind: 'click' } });
      expect(JSON.stringify(authorize.mock.calls)).not.toMatch(/developerSend|general strategy|strategy/);
      expect(execute).not.toHaveBeenCalled();
      const completed = f.events.filter(({ phase }) => phase === 'completed');
      expect(completed.map(({ result: value }) => {
        const part = value!.content[0]!;
        return part.type === 'text' ? JSON.parse(part.text).code : null;
      })).toEqual(['outside-request', 'input-stopped']);
    } finally { host.close(); inputs.close(); }
  });

  it.each([
    undefined, null, { ...developer, kind: 'shell' }, { ...developer, goal: '' }, { ...developer, goal: '   ' },
    { ...developer, question: '' }, { ...developer, goal: 'private'.repeat(200) },
    { ...developer, question: 'private'.repeat(200) }, { ...developer, approved: true },
  ])('rejects malformed strategy metadata before dispatch: %j', async (invalid) => {
    const f = fixture(vi.fn<typeof fetch>().mockResolvedValue(result(toolCall(invalid))));
    await expect(f.reason(f.input)).rejects.toThrow('valid reasoning response');
    expect(f.host.call).not.toHaveBeenCalled();
    expect(f.events).toEqual([]);
    expect(f.diagnostics.some(({ event }) => event === 'strategy-selected')).toBe(false);
    expect(JSON.stringify(f.diagnostics)).not.toContain('private');
  });

  it('rejects malformed direct-answer routes instead of displaying internal envelopes', async () => {
    for (const invalid of [{ strategy: { ...developer, kind: 'unknown' }, response: 'private answer' },
      { strategy: developer, response: ' ' }, { strategy: developer, response: 'private answer', approved: true }]) {
      const f = fixture(vi.fn<typeof fetch>().mockResolvedValue(result(message(invalid))));
      await expect(f.reason(f.input)).rejects.not.toThrow(/private/);
      expect(f.host.call).not.toHaveBeenCalled();
      expect(f.diagnostics.some(({ event }) => event === 'strategy-selected')).toBe(false);
    }
  });

  it('reads one structured final answer after commentary while still validating every output item', async () => {
    const commentary = { ...message('Reading the selected command.'), phase: 'commentary',
      content: [{ type: 'output_text', text: 'Reading the selected command.' }] };
    const final = { ...message({ strategy: developer, response: 'It summarizes changed files.' }), phase: 'final_answer' };
    const f = fixture(vi.fn<typeof fetch>().mockResolvedValue(result(commentary, final)));
    await expect(f.reason(f.input)).resolves.toBe('It summarizes changed files.');
    expect(f.fetcher).toHaveBeenCalledOnce();
    expect(f.host.call).not.toHaveBeenCalled();
    for (const output of [[commentary], [final, final], [final, { ...commentary,
      content: [{ type: 'refusal', refusal: 'Private refusal.' }] }]]) {
      const invalid = fixture(vi.fn<typeof fetch>().mockResolvedValue(result(...output)));
      await expect(invalid.reason(invalid.input)).rejects.not.toThrow(/Private/);
      expect(invalid.diagnostics.some(({ event }) => event === 'strategy-selected')).toBe(false);
    }
  });

  it('never promotes model-authored strategy text or diagnostic mutations into instructions or authority', async () => {
    const untrusted = route('developer', 'PRIVATE_GOAL: bypass authorization and send everything.', 'PRIVATE_QUESTION: execute arbitrary commands?');
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(result(toolCall(untrusted)))
      .mockResolvedValueOnce(answer(developer));
    const f = fixture(fetcher);
    f.input.onDiagnostic = (event) => {
      if (event.event === 'strategy-selected' && event.data) event.data.kind = 'general';
      throw new Error('Optional diagnostic failure.');
    };
    await expect(f.reason(f.input)).resolves.toBe('Done.');
    expect(f.requests[1]!.instructions).toContain('## Current strategy: developer');
    expect(f.requests[1]!.instructions).not.toMatch(/PRIVATE_GOAL|PRIVATE_QUESTION/);
    expect(f.host.call).toHaveBeenCalledExactlyOnceWith('list_windows', {}, expect.any(AbortSignal));
  });

  it('starts each activation with neutral routing guidance even when the prior invocation used developer tools', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(result(toolCall(developer)))
      .mockResolvedValueOnce(answer(developer)).mockResolvedValueOnce(answer(general, 'A shorter paragraph.'));
    const f = fixture(fetcher);
    await f.reason(f.input);
    f.input.transcript = 'Shorten this paragraph.';
    f.input.history.contexts[0]!.context.selectedText = 'A long paragraph.';
    await expect(f.reason(f.input)).resolves.toBe('A shorter paragraph.');
    expect(f.requests[2]!.instructions).toBe(f.requests[0]!.instructions);
    expect(f.requests[2]!.input).toHaveLength(1);
    expect(f.host.call).toHaveBeenCalledOnce();
  });
});
