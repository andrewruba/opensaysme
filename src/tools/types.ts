import type { z } from 'zod';
import type { ConversationEvidence } from '../conversation.js';
import type { DesktopIssue } from '../desktop/errors.js';

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  effect: 'read' | 'focus' | 'input';
}
export type ToolContent = { type: 'text'; text: string }
  | { type: 'image'; mimeType: 'image/jpeg'; data: string };
export interface ToolResult { content: ToolContent[]; isError?: boolean; desktopIssue?: DesktopIssue }
export interface ToolFeedbackTarget { application: string; title?: string }
export interface ToolHost {
  list(): ToolDescriptor[];
  call(name: string, args: unknown, signal: AbortSignal): Promise<ToolResult>;
  /** Historical evidence and labelled interpretations; never reusable handles or approvals. */
  conversationEvidence?(): ConversationEvidence;
  /** Display-only source evidence; resolving a label does not authorize or execute a tool. */
  feedbackTarget?(name: string, args: Record<string, unknown>): ToolFeedbackTarget | undefined;
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
