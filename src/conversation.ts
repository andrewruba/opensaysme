import { z } from 'zod';
import { performance } from 'node:perf_hooks';
import { windowInventorySchema, windowInspectionSchema } from './desktop/types.js';
import { desktopContextSchema } from './desktop/voice-types.js';
import { desktopInputSchema, inputEvidenceSchema, inputResultSchema } from './desktop/input-types.js';
import { keyboardActionSchema, keyboardEvidenceSchema } from './desktop/keyboard-types.js';

const windowSchema = windowInventorySchema.shape.windows.element;
export const conversationEvidenceSchema = z.object({
  windows: z.array(z.object({
    window: windowSchema, capturedAt: z.string().datetime(),
    nodes: windowInspectionSchema.options[0].shape.nodes.optional(),
    warnings: z.array(z.string().max(1024)).max(16),
  }).strict()).max(4),
  actions: z.array(z.object({
    window: windowSchema, capturedAt: z.string().datetime(), action: desktopInputSchema,
    target: inputEvidenceSchema.omit({ fingerprint: true }),
    point: z.object({ x: z.number().finite(), y: z.number().finite() }).strict(),
    effect: z.enum(['point', 'navigate', 'edit', 'submit', 'unknown']),
    status: inputResultSchema.shape.status,
  }).strict()).max(12),
  keyboardActions: z.array(z.object({
    capturedAt: z.string().datetime(), action: keyboardActionSchema,
    target: keyboardEvidenceSchema.omit({ fingerprint: true }),
    effect: z.enum(['navigate', 'edit', 'submit']), status: inputResultSchema.shape.status,
  }).strict()).max(12).optional(),
  // Model interpretations are retained separately from native action outcomes.
  // These labels support corrections and pending questions, never live handles.
  resolution: z.object({
    requestQuote: z.string().min(1).max(4096), source: z.string().max(1024).nullable(),
    question: z.string().max(512).nullable(),
    candidates: z.array(z.object({ application: z.string().max(1024), title: z.string().max(16_384).nullable(),
      status: z.enum(['possible', 'rejected', 'selected']), reason: z.string().max(512) }).strict()).max(8),
  }).strict().optional(),
}).strict();
export type ConversationEvidence = z.infer<typeof conversationEvidenceSchema>;
export const conversationTurnSchema = z.object({
  id: z.string().min(1).max(64), completedAt: z.string().datetime(),
  request: z.string().min(1).max(65_536), response: z.string().max(65_536),
  referenceContext: z.array(z.object({
    id: z.string().min(1).max(64), atMs: z.number().finite(), receivedAtMs: z.number().finite(),
    context: desktopContextSchema,
  }).strict()).max(3),
  evidence: conversationEvidenceSchema,
}).strict();
export type ConversationTurn = z.infer<typeof conversationTurnSchema>;
// Conservative development limits for memory, privacy and request size. These
// are tuning defaults to revisit after real follow-ups, not a product contract.
export const conversationSchema = z.array(conversationTurnSchema).max(3)
  .refine((turns) => Buffer.byteLength(JSON.stringify(turns)) <= 64 * 1024, 'Conversation exceeded its retention limit.');
export const conversationLifetimeMs = 120_000;

/** Factual, bounded context only. Images, tool handles and permission decisions
 * are absent from this schema; responses never stand in for native outcomes. */
export class RecentConversation {
  private entries: Array<{ at: number; turn: ConversationTurn }> = [];
  private timer?: NodeJS.Timeout;
  constructor(private readonly now: () => number = () => performance.now()) {}

  recent(): ConversationTurn[] {
    this.prune();
    return structuredClone(this.entries.map(({ turn }) => turn));
  }

  remember(turn: ConversationTurn): boolean {
    this.prune();
    const parsed = conversationSchema.safeParse([turn]);
    // Do not truncate user constraints or silently leave an older target as the
    // most recent turn when a newer one cannot be retained completely.
    if (!parsed.success) { this.clear(); return false; }
    this.entries.push({ at: this.now(), turn: parsed.data[0]! });
    while (!conversationSchema.safeParse(this.entries.map(({ turn }) => turn)).success) this.entries.shift();
    this.schedule();
    return true;
  }

  clear(): void { clearTimeout(this.timer); this.timer = undefined; this.entries = []; }

  private prune() {
    const now = this.now();
    this.entries = this.entries.filter(({ at }) => now >= at && now - at < conversationLifetimeMs);
    this.schedule();
  }
  private schedule() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.entries.length) {
      this.timer = setTimeout(() => this.prune(), Math.max(1, this.entries[0]!.at + conversationLifetimeMs - this.now()));
      this.timer.unref();
    }
  }
}
