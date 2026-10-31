import { z } from 'zod';
import type { ToolDefinition, ToolResult } from './types.js';
import { toolError } from './registry.js';

const reference = z.string().max(64).regex(/^evidence-[1-9]\d*$/);
const targetId = z.string().max(64).regex(/^(window|application)-[1-9]\d*$/);
const references = z.array(reference).min(1).max(8);
const candidate = z.object({ targetId, status: z.enum(['possible', 'rejected', 'selected']),
  evidenceIds: references, reason: z.string().min(1).max(512) }).strict();
export const resolutionInputSchema = z.object({
  requestQuote: z.string().min(1).max(4096),
  source: z.object({ description: z.string().min(1).max(1024), evidenceIds: references }).strict().nullable(),
  candidates: z.array(candidate).max(8), question: z.string().min(1).max(512).nullable(),
}).strict();
type Resolution = z.infer<typeof resolutionInputSchema>;
export interface ResolutionTarget { id: string; application: string; title?: string; kind: 'window' | 'application' }
interface Evidence {
  id: string; sequence: number; at: number; tool: string; targetIds: string[];
  available: boolean; content: boolean; text: string; truncated: boolean;
  windowId?: string;
}
const textResult = (value: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });

// Interpretation belongs to the model. This record enforces provenance, target
// identity and freshness; selecting a candidate never grants execution authority.
export class TargetResolution {
  private next = 0;
  private evidence = new Map<string, Evidence>();
  private current: Resolution | undefined;
  private rejectedAt = new Map<string, number>();
  private labels = new Map<string, ResolutionTarget>();
  private reviewed = false;
  constructor(private readonly request: string, private readonly target: (id: string) => ResolutionTarget | undefined,
    private readonly now: () => number = () => performance.now()) {}

  observe(tool: string, targetIds: string[], value: unknown, available = true, content = false, windowId?: string): string {
    const sequence = ++this.next, id = `evidence-${sequence}`;
    const raw = JSON.stringify(value);
    this.evidence.set(id, { id, sequence, at: this.now(), tool, targetIds: [...targetIds], available, content,
      text: raw.slice(0, 16_384), truncated: raw.length > 16_384, windowId });
    while (this.evidence.size > 48) this.evidence.delete(this.evidence.keys().next().value!);
    return id;
  }

  definition(): ToolDefinition {
    return { name: 'resolve_target', effect: 'read', input: resolutionInputSchema,
      description: 'Record the requested step, its source material, candidate destinations and an optional pending question. requestQuote must quote current user speech. Cite evidenceId values from tool results. Keep source separate from destination; mark unrelated candidates rejected, inaccessible ones possible. One selected candidate at most; selection needs a successful current content observation of that target. Focus alone and inventory names cannot select a destination for editing. Rejected candidates need new relevant evidence before reconsideration. Updates merge candidates for the same requestQuote; omitted candidates are retained. This records interpretation, never permission. Resolve before editing or submitting; exploration can continue while unresolved.',
      run: async (args, signal) => {
        signal.throwIfAborted();
        const input = resolutionInputSchema.parse(args);
        if (!input.requestQuote.trim() || !this.request.includes(input.requestQuote)) {
          return toolError('invalid-request-quote', 'Quote the current spoken request exactly; observations and plans cannot supply authority.');
        }
        const ids = [...(input.source?.evidenceIds ?? []), ...input.candidates.flatMap(({ evidenceIds }) => evidenceIds)];
        if (ids.some((id) => !this.evidence.has(id))) return toolError('unknown-evidence', 'A cited observation expired or was never returned. Inspect again.');
        if (new Set(input.candidates.map(({ targetId }) => targetId)).size !== input.candidates.length) {
          return toolError('duplicate-candidate', 'Record each candidate once.');
        }
        const sameStep = this.current?.requestQuote === input.requestQuote;
        const candidates = new Map((sameStep ? this.current!.candidates : []).map((entry) => [entry.targetId, entry]));
        // Selecting a new destination demotes the previous selection, but never
        // erases a rejection or makes discovery focus into supporting evidence.
        if (input.candidates.some(({ status }) => status === 'selected')) {
          for (const [id, entry] of candidates) if (entry.status === 'selected') candidates.set(id, { ...entry, status: 'possible' });
        }
        for (const entry of input.candidates) {
          if (!this.target(entry.targetId)) return toolError('stale-target', 'Rediscover this candidate before recording a resolution.');
          const cited = entry.evidenceIds.map((id) => this.evidence.get(id)!);
          if (!cited.some((item) => item.targetIds.includes(entry.targetId))) {
            return toolError('unrelated-evidence', 'Cite an observation of this candidate, not only the source material or another destination.');
          }
          if (entry.status === 'selected') {
            const after = sameStep ? this.rejectedAt.get(entry.targetId) ?? 0 : 0;
            if (!cited.some((item) => item.targetIds.includes(entry.targetId) && item.available && item.content
              && item.sequence > after && this.now() - item.at <= 30_000)) {
              return toolError('destination-unresolved', 'Selection needs fresh successful content evidence for this target; a failed capture, inventory or previous rejection is insufficient.');
            }
          }
          candidates.set(entry.targetId, entry);
        }
        if (candidates.size > 8 || [...candidates.values()].filter(({ status }) => status === 'selected').length > 1) {
          return toolError('ambiguous-resolution', 'Keep at most eight candidates and select at most one destination.');
        }
        if (!sameStep) this.rejectedAt.clear();
        for (const entry of input.candidates) {
          this.labels.set(entry.targetId, { ...this.target(entry.targetId)! });
          if (entry.status === 'rejected') this.rejectedAt.set(entry.targetId, this.next);
        }
        // Updating context requires a new first-edit destination review. This is
        // independent of authority, which is always the original user request.
        this.reviewed = false;
        this.current = { ...input, candidates: [...candidates.values()] };
        for (const id of this.labels.keys()) if (!candidates.has(id)) this.labels.delete(id);
        return textResult({ resolution: this.snapshot(), message: 'Recorded interpretation. Native target checks and the original request still govern actions.' });
      } };
  }

  check(target: { application: string; applicationId?: string; windowId?: string }): string | undefined {
    const selected = this.current?.candidates.find(({ status }) => status === 'selected');
    if (!selected || this.current?.question) return 'Resolve the intended destination with current evidence before changing content.';
    const actual = this.target(selected.targetId);
    if (!actual || actual.application !== target.application
      || (actual.kind === 'window' ? actual.id !== target.windowId : actual.id !== target.applicationId)) {
      return 'The actual input destination differs from the selected candidate. Inspect and resolve the intended target again.';
    }
    if (!selected.evidenceIds.some((id) => {
      const item = this.evidence.get(id);
      return item?.available && item.content && item.targetIds.includes(selected.targetId) && this.now() - item.at <= 30_000
        && (actual.kind === 'window' || item.windowId === target.windowId);
    })) return 'Destination evidence expired. Inspect the selected destination and update its resolution before editing.';
    return undefined;
  }

  snapshot(): unknown {
    if (!this.current) return { status: 'unresolved' };
    const ids = new Set([...this.current.candidates.filter(({ status }) => status === 'selected').flatMap(({ evidenceIds }) => evidenceIds),
      ...(this.current.source?.evidenceIds ?? []), ...this.current.candidates.flatMap(({ evidenceIds }) => evidenceIds)]);
    let remaining = 32_768;
    return { ...structuredClone(this.current),
      evidence: [...ids].flatMap((id) => {
        const item = this.evidence.get(id);
        const text = item?.text.slice(0, remaining) ?? '';
        remaining -= text.length;
        return item ? [{ id, tool: item.tool, targetIds: item.targetIds, available: item.available,
          content: item.content, ageMs: Math.max(0, Math.round(this.now() - item.at)), text, truncated: item.truncated || text.length < item.text.length }] : [];
      }) };
  }
  reviewRequired(): boolean { return !this.reviewed; }
  markReviewed(): void { this.reviewed = true; }

  history() {
    if (!this.current) return undefined;
    return { requestQuote: this.current.requestQuote, source: this.current.source?.description ?? null, question: this.current.question,
      candidates: this.current.candidates.map((entry) => ({ application: this.labels.get(entry.targetId)?.application ?? 'Unavailable',
        title: this.labels.get(entry.targetId)?.title ?? null, status: entry.status, reason: entry.reason })) };
  }
  close(): void { this.evidence.clear(); this.current = undefined; this.rejectedAt.clear(); this.labels.clear(); }
}
