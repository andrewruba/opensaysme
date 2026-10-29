import type { z } from 'zod';

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  effect: 'read' | 'focus';
}
export type ToolContent = { type: 'text'; text: string }
  | { type: 'image'; mimeType: 'image/jpeg'; data: string };
export interface ToolResult { content: ToolContent[]; isError?: boolean }
export interface ToolHost {
  list(): ToolDescriptor[];
  call(name: string, args: unknown, signal: AbortSignal): Promise<ToolResult>;
  close(): void;
}
export interface ToolDefinition {
  name: string;
  description: string;
  input: z.ZodObject;
  effect: ToolDescriptor['effect'];
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
