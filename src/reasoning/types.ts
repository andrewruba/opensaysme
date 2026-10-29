import type { AttentionHistory } from '../attention.js';
import type { PreparedVisualContext } from '../visual-input.js';
import type { DiagnosticSink, PreparedReasoningRequest } from '../diagnostics.js';

export interface ReasoningInput {
  transcript: string;
  history: AttentionHistory;
  visual: PreparedVisualContext;
  signal: AbortSignal;
  onRequest?: (request: PreparedReasoningRequest) => void;
  onDiagnostic?: DiagnosticSink;
}
export type ReasoningFactory = (input: ReasoningInput) => Promise<string>;
