import { describe, expect, it } from 'vitest';
import { transcriptionKeywords } from '../src/speech/keywords.js';

describe('transcription vocabulary', () => {
  it('trims and deduplicates literal names without aliases or transcript rewriting', () => {
    expect(transcriptionKeywords([' Aster Project ', 'aster project', 'Birch', 'café', '🌱', '', '   ']))
      .toEqual(['Aster Project', 'Birch', 'café', '🌱']);
  });

  it('drops labels containing provider-forbidden characters, controls or line separators', () => {
    const invalid = ['<label>', 'label>', 'two\nlines', 'two\rlines', 'two\twords', 'null\0byte', 'del\u007f', 'c1\u0085',
      'line\u2028break', 'paragraph\u2029break'];
    expect(transcriptionKeywords([...invalid, 'Safe name'])).toEqual(['Safe name']);
  });

  it('bounds terms and aggregate UTF-16 length without truncating names or surrogate pairs', () => {
    expect(transcriptionKeywords(['a'.repeat(97), '🌱'.repeat(49), '🌱'.repeat(48)]))
      .toEqual(['🌱'.repeat(48)]);
    const many = Array.from({ length: 40 }, (_, index) => `Project ${index}`);
    expect(transcriptionKeywords(many)).toEqual(many.slice(0, 32));
    const large = Array.from({ length: 30 }, (_, index) => `${index}`.padEnd(96, 'x'));
    const bounded = transcriptionKeywords([...large, 'short']);
    expect(bounded).toEqual([...large.slice(0, 21), 'short']);
    expect(bounded.reduce((sum, value) => sum + value.length, 0)).toBeLessThanOrEqual(2048);
  });
});
