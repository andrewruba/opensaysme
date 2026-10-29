import type { AttentionHistory } from './attention.js';
import type { PreparedVisualContext } from './visual-input.js';

export interface DiagnosticEvent {
  component: 'session' | 'desktop' | 'speech' | 'reasoning' | 'runtime';
  event: string;
  turnId?: string;
  data?: Record<string, string | number | boolean | null>;
}
export type DiagnosticSink = (event: DiagnosticEvent) => void;

/** Same prompt/settings as the provider request; image URLs name local bundle files. */
export interface PreparedReasoningRequest {
  model: string;
  instructions: string;
  store: false;
  max_output_tokens: number;
  input: Array<{ role: 'user'; content: Array<
    { type: 'input_text'; text: string } |
    { type: 'input_image'; image_url: string; detail: 'high' }
  > }>;
}
export interface DebugTurnInput {
  transcript: string;
  history: AttentionHistory;
  visual?: PreparedVisualContext;
}
export interface DebugTurnResult {
  status: 'completed' | 'cancelled' | 'failed' | 'interrupted';
  response?: string;
  error?: { component?: string; code?: string; message?: string };
  latency?: Record<string, number | undefined>;
}

/** Calls snapshot/queue bounded data synchronously; disk work does not gate voice. */
export interface DebugSession {
  directory: string;
  event: DiagnosticSink;
  input(turnId: string, input: DebugTurnInput): void;
  request(turnId: string, request: PreparedReasoningRequest): void;
  result(turnId: string, result: DebugTurnResult): void;
  turnDirectory(turnId: string): string;
  close(): Promise<void>;
}
