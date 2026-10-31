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
