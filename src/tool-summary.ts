import { desktopIssueSchema, type DesktopIssue } from './desktop/errors.js';
import type { ToolDescriptor, ToolEvent } from './tools/types.js';

const localFailureCodes = [
  'closed', 'unknown-tool', 'busy', 'invalid-arguments', 'tool-failed',
  'input-stopped', 'request-required', 'stale-observation', 'reserved-shortcut',
  'keyboard-unavailable', 'permission-unavailable', 'outside-request', 'input-uncertain',
  'unknown-window', 'stale-window', 'content-unavailable', 'outside-image',
  'input-target-unavailable', 'input-not-focused', 'accessibility-permission-required',
  'ambiguous-target', 'inaccessible', 'capture-failed',
] as const;
type ToolFailureCode = typeof localFailureCodes[number] | DesktopIssue;

export interface ToolSummary {
  name: string;
  effect: ToolDescriptor['effect'];
  outcome: 'ok' | 'partial' | 'failed' | 'issued' | 'verified' | 'not-issued' | 'uncertain';
  code?: ToolFailureCode;
  desktopIssue?: DesktopIssue;
}

/** Default output contains finite outcome metadata, never captured content or arguments. */
export function summarizeTool(event: ToolEvent, catalog: ToolDescriptor[]): ToolSummary | undefined {
  if (event.phase !== 'completed' || !/^[a-z][a-z0-9_]{0,63}$/.test(event.name)
    || !['read', 'focus', 'input'].includes(event.effect)
    || !catalog.some((tool) => tool.name === event.name && tool.effect === event.effect)) return undefined;
  let outcome: ToolSummary['outcome'] = event.result && !event.result.isError ? 'ok' : 'failed';
  let code: ToolFailureCode | undefined;
  const first = event.result?.content[0];
  if (first?.type === 'text' && first.text.length <= 512 * 1024) {
    try {
      const result: unknown = JSON.parse(first.text);
      if (result && typeof result === 'object' && !Array.isArray(result)) {
        const { status, code: failure } = result as { status?: unknown; code?: unknown };
        if (event.effect === 'input' && (status === 'issued' || status === 'verified' || status === 'not-issued' || status === 'uncertain')) outcome = status;
        // Only failed local tool results can supply a code. Screen content and
        // arbitrary error strings must never become printable diagnostics.
        if (event.result?.isError) code = localFailureCodes.find((known) => known === failure)
          ?? desktopIssueSchema.safeParse(failure).data;
      }
    } catch { /* Malformed or arbitrary content supplies no printable metadata. */ }
  }
  const issue = desktopIssueSchema.safeParse(event.result?.desktopIssue);
  if (outcome === 'ok' && issue.success) outcome = 'partial';
  return { name: event.name, effect: event.effect, outcome, ...(code ? { code } : {}), ...(issue.success ? { desktopIssue: issue.data } : {}) };
}

export function formatToolSummary(summary: ToolSummary): string {
  const codes = [...new Set([summary.code, summary.desktopIssue].filter(Boolean))];
  return `Tool: ${summary.name} — ${summary.outcome}${codes.length ? ` (${codes.join(', ')})` : ''}`;
}
