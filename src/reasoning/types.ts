import type { AttentionHistory } from '../attention.js';
import type { PreparedVisualContext } from '../visual-input.js';

export interface ReasoningInput {
  transcript: string;
  history: AttentionHistory;
  visual: PreparedVisualContext;
  signal: AbortSignal;
}
export type ReasoningFactory = (input: ReasoningInput) => Promise<string>;
