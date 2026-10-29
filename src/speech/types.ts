export interface TranscriptionSession {
  ready: Promise<void>;
  finished: Promise<string>;
  append(pcm: Buffer): void;
  commit(): void;
  close(): void;
}

export interface TranscriptionOptions {
  apiKey: string;
  model: string;
  signal: AbortSignal;
  onDelta: (text: string) => void;
}
export type TranscriptionFactory = (options: TranscriptionOptions) => TranscriptionSession;
