import { expect, it } from 'vitest';
import { formatToolSummary, summarizeTool } from '../src/tool-summary.js';
import type { ToolDescriptor, ToolEvent } from '../src/tools/types.js';

const catalog: ToolDescriptor[] = [
  { name: 'capture_screen', description: 'Capture', effect: 'read', inputSchema: {} },
  { name: 'press_key', description: 'Press a key', effect: 'input', inputSchema: {} },
];
const event: ToolEvent = { callId: 'private-call-id', name: 'capture_screen', effect: 'read', phase: 'completed',
  arguments: { private: 'private arguments' }, result: { desktopIssue: 'accessibility-unavailable', content: [
    { type: 'text', text: JSON.stringify({ keyboardUnavailable: 'private diagnostic', value: 'private captured value' }) },
    { type: 'image', mimeType: 'image/jpeg', data: 'private image data' },
  ] } };

it('renders partial read failures as safe finite metadata without copied context or arguments', () => {
  const result = summarizeTool(event, catalog);
  expect(result).toEqual({ name: 'capture_screen', effect: 'read', outcome: 'partial', desktopIssue: 'accessibility-unavailable' });
  expect(formatToolSummary(result!)).toBe('Tool: capture_screen — partial (accessibility-unavailable)');
  expect(JSON.stringify(result)).not.toContain('private');
});

it.each(['issued', 'verified', 'not-issued', 'uncertain'] as const)('preserves the native %s outcome without copying other fields', (status) => {
  const result = summarizeTool({ ...event, name: 'press_key', effect: 'input', result: {
    isError: ['not-issued', 'uncertain'].includes(status), content: [{ type: 'text', text: JSON.stringify({ status, text: 'private typed value', permission: { reason: 'private guard reason' } }) }],
  } }, catalog);
  expect(result).toEqual({ name: 'press_key', effect: 'input', outcome: status });
});

it.each(['stale-observation', 'invalid-arguments', 'reserved-shortcut', 'permission-unavailable', 'outside-request'])(
'identifies a %s failure without copying the action or guard explanation', (code) => {
  const summary = summarizeTool({ ...event, name: 'press_key', effect: 'input', result: {
    isError: true, content: [{ type: 'text', text: JSON.stringify({ code,
      message: 'private target details', permission: { reason: 'private request quote' } }) }],
  } }, catalog);
  expect(summary).toEqual({ name: 'press_key', effect: 'input', outcome: 'failed', code });
  expect(formatToolSummary(summary!)).toBe(`Tool: press_key — failed (${code})`);
  expect(JSON.stringify(summary)).not.toContain('private');
});

it('prints shared desktop/tool error codes once and retains distinct local failure context', () => {
  const failed = { ...event, name: 'press_key', effect: 'input' as const, result: {
    isError: true, desktopIssue: 'input-unavailable' as const,
    content: [{ type: 'text' as const, text: '{"code":"input-unavailable","message":"private target"}' }],
  } };
  const summary = summarizeTool(failed, catalog)!;
  expect(summary.code).toBe('input-unavailable');
  expect(formatToolSummary(summary)).toBe('Tool: press_key — failed (input-unavailable)');
  failed.result.content[0]!.text = '{"code":"input-uncertain","message":"private target"}';
  expect(formatToolSummary(summarizeTool(failed, catalog)!))
    .toBe('Tool: press_key — failed (input-uncertain, input-unavailable)');
});

it('does not extract failure codes from successful evidence, nested content, or arbitrary strings', () => {
  const result = (text: string, isError = true): ToolEvent => ({ ...event, result: {
    isError, content: [{ type: 'text', text }],
  } });
  expect(summarizeTool(result('{"code":"outside-request"}', false), catalog))
    .toEqual({ name: 'capture_screen', effect: 'read', outcome: 'ok' });
  for (const text of ['{"value":{"code":"outside-request"}}', '{"code":"private-token"}',
    '{"code":"stale-observation\\nprivate data"}', '{"code":["outside-request"]}', '{"code":"__proto__"}',
    'private invalid JSON']) {
    expect(summarizeTool(result(text), catalog))
      .toEqual({ name: 'capture_screen', effect: 'read', outcome: 'failed' });
  }
});

it('does not expose arbitrary result statuses, error text, issue codes, or unadvertised tool names', () => {
  const invalid: ToolEvent = { ...event, name: 'press_key', effect: 'input', result: {
    isError: true, desktopIssue: 'private error' as never,
    content: [{ type: 'text', text: '{"status":"private error","code":"private code"}' }],
  } };
  expect(summarizeTool(invalid, catalog)).toEqual({ name: 'press_key', effect: 'input', outcome: 'failed' });
  expect(summarizeTool({ ...event, name: 'private_unadvertised_name' }, catalog)).toBeUndefined();
  expect(summarizeTool({ ...event, name: 'capture_screen\nprivate' }, catalog)).toBeUndefined();
  expect(summarizeTool({ ...event, effect: 'input' }, catalog)).toBeUndefined();
  expect(summarizeTool({ ...event, phase: 'started' }, catalog)).toBeUndefined();
});
