import type { AttentionHistory } from '../attention.js';
import type { PreparedVisualContext } from '../visual-input.js';
import type { DiagnosticSink, PreparedReasoningRequest } from '../diagnostics.js';
import type { ToolEvent, ToolHost } from '../tools/types.js';
import type { ConversationTurn } from '../conversation.js';
import type { WorkReference } from '../work-context.js';

export interface ReasoningInput {
  transcript: string;
  history: AttentionHistory;
  visual: PreparedVisualContext;
  signal: AbortSignal;
  conversation?: ConversationTurn[];
  workContext?: WorkReference[];
  tools?: ToolHost;
  onTool?: (event: ToolEvent) => void;
  onRequest?: (request: PreparedReasoningRequest, step?: number) => void;
  onDiagnostic?: DiagnosticSink;
}
export type ReasoningFactory = (input: ReasoningInput) => Promise<string>;
