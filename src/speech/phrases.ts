import type { TranscriptionPhrase } from './types.js';

export type PhraseInterval = Pick<TranscriptionPhrase, 'startSample' | 'endSample' | 'boundary'>;
interface AudioPart { pcm: Buffer; interval?: PhraseInterval }
const windowSamples = 480; // 20 ms at 24 kHz.
const pauseSamples = 9_600; // Finalize after 400 ms of low energy.
const maxPhraseSamples = 96_000; // Bound alignment uncertainty to four seconds.
const speechRms = 350; // PCM16 amplitude; a boundary heuristic, not a speech classifier.

/** Selects commit boundaries without buffering, dropping, or replaying audio. */
export class PhraseSegmenter {
  private samples = 0;
  private start = 0;
  private energy = 0;
  private window = 0;
  private quiet = 0;
  private voiced = false;

  append(pcm: Buffer): AudioPart[] {
    const parts: AudioPart[] = [];
    let from = 0;
    for (let offset = 0; offset < pcm.length; offset += 2) {
      const value = pcm.readInt16LE(offset);
      this.energy += value * value;
      this.samples++;
      if (++this.window < windowSamples) continue;
      if (this.energy / this.window >= speechRms * speechRms) {
        this.voiced = true;
        this.quiet = 0;
      } else this.quiet += this.window;
      this.window = 0;
      this.energy = 0;
      const boundary = this.samples - this.start >= maxPhraseSamples ? 'limit'
        : this.voiced && this.quiet >= pauseSamples ? 'pause' : undefined;
      if (boundary) {
        parts.push({ pcm: pcm.subarray(from, offset + 2), interval: this.interval(boundary) });
        from = offset + 2;
      }
    }
    if (from < pcm.length) parts.push({ pcm: pcm.subarray(from) });
    return parts;
  }

  finish(): PhraseInterval | undefined {
    return this.samples > this.start ? this.interval('stop') : undefined;
  }

  private interval(boundary: PhraseInterval['boundary']): PhraseInterval {
    const result = { startSample: this.start, endSample: this.samples, boundary };
    this.start = this.samples;
    this.quiet = 0;
    this.voiced = false;
    return result;
  }
}
