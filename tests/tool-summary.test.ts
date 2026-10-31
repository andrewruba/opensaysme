import { expect, it } from 'vitest';
import { formatToolSummary, summarizeTool } from '../src/tool-summary.js';
import { inputFailureReasonSchema } from '../src/desktop/input-types.js';
import type { ToolDescriptor, ToolEvent } from '../src/tools/types.js';

const catalog: ToolDescriptor[] = [
  { name: 'capture_screen', description: 'Capture', effect: 'read', inputSchema: {} },
  { name: 'press_key', description: 'Press a key', effect: 'input', inputSchema: {} },
];
const event: ToolEvent = { callId: 'private-call-id', name: 'capture_screen', effect: 'read', phase: 'completed',
  arguments: { private: 'private arguments' }, result: { desktopIssue: 'accessibility-unavailable', content: [
    { type: 'text', text: JSON.stringify({ keyboardIssue: 'accessibility-unavailable', keyboardUnavailable: 'private diagnostic', value: 'private captured value' }) },
    { type: 'image', mimeType: 'image/jpeg', data: 'private image data' },
  ] } };

it('renders partial read failures as safe finite metadata without copied context or arguments', () => {
  const result = summarizeTool(event, catalog);
  expect(result).toEqual({ name: 'capture_screen', effect: 'read', outcome: 'partial', desktopIssue: 'accessibility-unavailable', keyboardFocus: 'unavailable' });
  expect(formatToolSummary(result!)).toBe('Tool: capture_screen — partial (accessibility-unavailable, keyboard: unavailable)');
  expect(JSON.stringify(result)).not.toContain('private');
});

it.each(['issued', 'verified', 'not-issued', 'uncertain'] as const)('preserves the native %s outcome without copying other fields', (status) => {
  const result = summarizeTool({ ...event, name: 'press_key', effect: 'input', result: {
    isError: ['not-issued', 'uncertain'].includes(status), content: [{ type: 'text', text: JSON.stringify({ status, text: 'private typed value', permission: { reason: 'private guard reason' } }) }],
  } }, catalog);
  expect(result).toEqual({ name: 'press_key', effect: 'input', outcome: status });
});

it.each(['stale-observation', 'invalid-arguments', 'reserved-shortcut', 'permission-unavailable', 'outside-request', 'unsupported-text-target'])(
'identifies a %s failure without copying the action or guard explanation', (code) => {
  const summary = summarizeTool({ ...event, name: 'press_key', effect: 'input', result: {
    isError: true, content: [{ type: 'text', text: JSON.stringify({ code,
      message: 'private target details', permission: { reason: 'private request quote' } }) }],
  } }, catalog);
  expect(summary).toEqual({ name: 'press_key', effect: 'input', outcome: 'failed', code });
  expect(formatToolSummary(summary!)).toBe(`Tool: press_key — failed (${code})`);
  expect(JSON.stringify(summary)).not.toContain('private');
});

it.each([[true, 'editable'], [false, 'non-editable']] as const)(
  'reports editable=%s keyboard readiness without copying focused control details', (editable, readiness) => {
    const summary = summarizeTool({ ...event, result: { content: [{ type: 'text', text: JSON.stringify({
      keyboardObservationId: 'private observation', keyboardFocus: {
        editable, application: 'private application', title: 'private title', description: 'private description', value: 'private text',
      },
    }) }] } }, catalog);
    expect(summary).toEqual({ name: 'capture_screen', effect: 'read', outcome: 'ok', keyboardFocus: readiness });
    expect(formatToolSummary(summary!)).toBe(`Tool: capture_screen — ok (keyboard: ${readiness})`);
    expect(JSON.stringify(summary)).not.toContain('private');
  });

it('does not infer keyboard readiness from malformed, missing, nested or unrelated metadata', () => {
  for (const metadata of [
    { keyboardFocus: { editable: 'private text' } }, { keyboardFocus: { editable: 1 } },
    { keyboardFocus: 'editable' }, { keyboardFocus: [{ editable: true }] }, { editable: true },
    { value: { keyboardFocus: { editable: true } } }, { keyboardIssue: 'private issue' },
    { keyboardUnavailable: 'private diagnostic' }, {},
  ]) {
    expect(summarizeTool({ ...event, result: { content: [{ type: 'text', text: JSON.stringify(metadata) }] } }, catalog))
      .toEqual({ name: 'capture_screen', effect: 'read', outcome: 'ok' });
  }
  const result = { content: [{ type: 'text' as const, text: '{"keyboardFocus":{"editable":true}}' }] };
  expect(summarizeTool({ ...event, result: { ...result, isError: true } }, catalog))
    .toEqual({ name: 'capture_screen', effect: 'read', outcome: 'failed' });
  expect(summarizeTool({ ...event, name: 'press_key', effect: 'input', result }, catalog))
    .toEqual({ name: 'press_key', effect: 'input', outcome: 'ok' });
});

it('does not report editable focus when a known focus issue contradicts it', () => {
  const summary = summarizeTool({ ...event, result: { desktopIssue: 'focus-changed', content: [{ type: 'text',
    text: '{"keyboardFocus":{"editable":true},"keyboardIssue":"focus-changed"}',
  }] } }, catalog);
  expect(summary).toEqual({ name: 'capture_screen', effect: 'read', outcome: 'partial', desktopIssue: 'focus-changed', keyboardFocus: 'unavailable' });
});

it.each(inputFailureReasonSchema.options)('preserves the finite native rejection reason %s without captured details', (code) => {
  const summary = summarizeTool({ ...event, name: 'press_key', effect: 'input', result: {
    isError: true, content: [{ type: 'text', text: JSON.stringify({ status: 'not-issued', code,
      message: 'private native details', target: { value: 'private captured value' } }) }],
  } }, catalog);
  expect(summary).toEqual({ name: 'press_key', effect: 'input', outcome: 'not-issued', code });
  expect(formatToolSummary(summary!)).toBe(`Tool: press_key — not-issued (${code})`);
  expect(JSON.stringify(summary)).not.toContain('private');
});

it('accepts native verification failure codes only on failed input outcomes', () => {
  const content = [{ type: 'text' as const, text: '{"status":"uncertain","code":"text-value-mismatch"}' }];
  expect(summarizeTool({ ...event, name: 'press_key', effect: 'input', result: { isError: true, content } }, catalog))
    .toEqual({ name: 'press_key', effect: 'input', outcome: 'uncertain', code: 'text-value-mismatch' });
  expect(summarizeTool({ ...event, result: { isError: true, content } }, catalog))
    .toEqual({ name: 'capture_screen', effect: 'read', outcome: 'failed' });
  expect(summarizeTool({ ...event, name: 'press_key', effect: 'input', result: { content } }, catalog))
    .toEqual({ name: 'press_key', effect: 'input', outcome: 'uncertain' });
  for (const metadata of [
    { status: 'issued', code: 'event-creation-failed' }, { code: 'event-creation-failed' },
    { status: 'not-issued', code: 'private native reason' }, { status: 'not-issued', code: ['event-creation-failed'] },
    { status: 'not-issued', reason: 'event-creation-failed' },
  ]) {
    const summary = summarizeTool({ ...event, name: 'press_key', effect: 'input', result: {
      isError: true, content: [{ type: 'text', text: JSON.stringify(metadata) }],
    } }, catalog);
    expect(summary?.code).toBeUndefined();
    expect(JSON.stringify(summary)).not.toContain('private');
  }
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
