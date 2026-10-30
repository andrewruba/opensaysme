import type { z } from 'zod';
import type { ConversationEvidence } from '../conversation.js';

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  effect: 'read' | 'focus' | 'input';
}
export type ToolContent = { type: 'text'; text: string }
  | { type: 'image'; mimeType: 'image/jpeg'; data: string };
export interface ToolResult { content: ToolContent[]; isError?: boolean }
export interface ToolHost {
  list(): ToolDescriptor[];
  call(name: string, args: unknown, signal: AbortSignal): Promise<ToolResult>;
  /** Historical native evidence only; never reusable tool handles or approvals. */
  conversationEvidence?(): ConversationEvidence;
  close(): void;
}
export interface ToolDefinition {
  name: string;
  description: string;
  input: z.ZodObject;
  effect: ToolDescriptor['effect'];
  timeoutMs?: number;
  run(args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult>;
}
export interface ToolEvent {
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
  phase: 'started' | 'completed';
  effect: ToolDescriptor['effect'];
  durationMs?: number;
  result?: ToolResult;
}
