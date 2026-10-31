import type { DiagnosticSink } from '../diagnostics.js';

export interface TranscriptionSession {
  ready: Promise<void>;
  finished: Promise<string>;
  append(pcm: Buffer): void;
  /** Optional vocabulary hints; these never rewrite the returned transcript. */
  updateKeywords?(keywords: string[]): void;
  commit(): void;
  close(): void;
}

/** A committed audio interval, not provider word timestamps or exact speech boundaries. */
export interface TranscriptionPhrase {
  id: string;
  text: string;
  startSample: number;
  endSample: number;
  boundary: 'pause' | 'limit' | 'stop';
}

export interface TranscriptionOptions {
  apiKey: string;
  model: string;
  signal: AbortSignal;
  keywords?: string[];
  /** Full ordered text so completed phrases can correct earlier streaming text. */
  onPartial: (text: string) => void;
  onPhrase: (phrase: TranscriptionPhrase) => void;
  onDiagnostic?: DiagnosticSink;
}
export type TranscriptionFactory = (options: TranscriptionOptions) => TranscriptionSession;
