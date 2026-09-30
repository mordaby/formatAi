import { describe, expect, it } from 'vitest';
import { nm, val } from './parts';
import { PHRASE_KEYS, phrasebook, type PhraseKey } from './phrases';
import type { Part } from './types';

const placeholders = (template: string): string[] => [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();

describe('phrase dictionaries', () => {
  const en = phrasebook('en');
  const he = phrasebook('he');

  it('use the same placeholders in both languages', () => {
    for (const key of PHRASE_KEYS) {
      expect(placeholders(he.raw(key)), key).toEqual(placeholders(en.raw(key)));
    }
  });

  it('have both forms of every counted phrase', () => {
    for (const key of PHRASE_KEYS) {
      if (key.endsWith('.one')) expect(PHRASE_KEYS, key).toContain(key.replace(/\.one$/, '.other') as PhraseKey);
      if (key.endsWith('.other')) expect(PHRASE_KEYS, key).toContain(key.replace(/\.other$/, '.one') as PhraseKey);
    }
  });

  it('never write jargon in the English text', () => {
    for (const key of PHRASE_KEYS) expect(en.raw(key), key).not.toMatch(/\b(schema|validate|validation|expression|AST)\b/i);
  });

  it('write Hebrew letters in every Hebrew sentence that has words', () => {
    const wordless = new Set<PhraseKey>(['cond.andJoin', 'cond.orJoin', 'expand.fanCell', 'file.enc.utf8bom', 'file.enc.utf8', 'file.enc.windows1255']);
    for (const key of PHRASE_KEYS) {
      if (wordless.has(key)) continue;
      expect(he.raw(key), key).toMatch(/[א-ת]/);
    }
  });

  it('have no direction marks', () => {
    for (const key of PHRASE_KEYS) {
      expect(en.raw(key)).not.toMatch(/[‎‏‪-‮⁦-⁩]/);
      expect(he.raw(key)).not.toMatch(/[‎‏‪-‮⁦-⁩]/);
    }
  });
});

describe('templates', () => {
  it('fill placeholders with styled parts and keep the words around them as text', () => {
    const parts = phrasebook('en').t('cond.ne', { a: nm('Status'), b: val("'Cancelled'") });
    expect(parts).toEqual([
      { kind: 'name', text: 'Status' },
      { kind: 'text', text: ' is not ' },
      { kind: 'value', text: "'Cancelled'" },
    ]);
  });

  it('pick the singular for exactly one', () => {
    const text = (parts: Part[]): string => parts.map((p) => p.text).join('');
    expect(text(phrasebook('en').tn('values', 1))).toBe('1 value');
    expect(text(phrasebook('en').tn('values', 0))).toBe('0 values');
    expect(text(phrasebook('en').tn('values', 12))).toBe('12 values');
    expect(text(phrasebook('he').tn('values', 1))).toBe('ערך אחד');
    expect(text(phrasebook('he').tn('values', 12))).toBe('12 ערכים');
  });

  it('render a missing argument as nothing instead of failing', () => {
    expect(phrasebook('en').t('cond.ne', { a: nm('X') }).map((p) => p.text).join('')).toBe('X is not ');
  });
});

describe('lists', () => {
  const list = (lang: 'en' | 'he', kind: 'and' | 'or', items: string[]): string =>
    phrasebook(lang)[kind](items.map((i): Part[] => [nm(i)])).map((p) => p.text).join('');

  it('join items the English way', () => {
    expect(list('en', 'and', ['A'])).toBe('A');
    expect(list('en', 'and', ['A', 'B'])).toBe('A and B');
    expect(list('en', 'and', ['A', 'B', 'C'])).toBe('A, B and C');
    expect(list('en', 'or', ['A', 'B', 'C'])).toBe('A, B or C');
  });

  it('join items the Hebrew way, with a hyphen only before Latin text and numbers', () => {
    expect(list('he', 'and', ['א', 'ב', 'ג'])).toBe('א, ב וג');
    expect(list('he', 'and', ['א', 'Cost'])).toBe('א ו-Cost');
    expect(list('he', 'and', ['א', "'B'"])).toBe("א ו-'B'");
    expect(list('he', 'and', ['א', "'ב'"])).toBe("א ו'ב'");
    expect(list('he', 'or', ['א', 'Cost'])).toBe('א או Cost');
  });
});
