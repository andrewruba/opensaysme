import { desktopIssueSchema, type DesktopIssue } from './desktop/errors.js';
import type { ToolDescriptor, ToolEvent } from './tools/types.js';

export interface ToolSummary {
  name: string;
  effect: ToolDescriptor['effect'];
  outcome: 'ok' | 'partial' | 'failed' | 'issued' | 'verified' | 'not-issued' | 'uncertain';
  desktopIssue?: DesktopIssue;
}

/** Default output contains finite outcome metadata, never captured content or arguments. */
export function summarizeTool(event: ToolEvent, catalog: ToolDescriptor[]): ToolSummary | undefined {
  if (event.phase !== 'completed' || !/^[a-z][a-z0-9_]{0,63}$/.test(event.name)
    || !['read', 'focus', 'input'].includes(event.effect)
    || !catalog.some((tool) => tool.name === event.name && tool.effect === event.effect)) return undefined;
  let outcome: ToolSummary['outcome'] = event.result && !event.result.isError ? 'ok' : 'failed';
  if (event.effect === 'input') {
    const first = event.result?.content[0];
    if (first?.type === 'text' && first.text.length <= 512 * 1024) {
      try {
        const status: unknown = (JSON.parse(first.text) as { status?: unknown } | null)?.status;
        if (status === 'issued' || status === 'verified' || status === 'not-issued' || status === 'uncertain') outcome = status;
      } catch { /* Malformed or arbitrary content supplies no printable metadata. */ }
    }
  }
  const issue = desktopIssueSchema.safeParse(event.result?.desktopIssue);
  if (outcome === 'ok' && issue.success) outcome = 'partial';
  return { name: event.name, effect: event.effect, outcome, ...(issue.success ? { desktopIssue: issue.data } : {}) };
}

export function formatToolSummary(summary: ToolSummary): string {
  return `Tool: ${summary.name} — ${summary.outcome}${summary.desktopIssue ? ` (${summary.desktopIssue})` : ''}`;
}
