// Phrase lookup for the rules map: one dictionary per language, plus the list joiners
// ("A, B and C") that differ by language. Kept apart from the app's own i18n dictionaries on
// purpose (the rules map is built outside React and needs placeholders that take styled parts).
import { fill, type Arg } from './parts';
import { en, enJoiners } from './phrases.en';
import { he, heJoiners } from './phrases.he';
import type { Part, RulesTextLang } from './types';

export type PhraseKey = keyof typeof en;
/** `x` for every pair of keys `x.one` / `x.other`. */
export type PluralBase<K extends string = PhraseKey> = K extends `${infer B}.one` ? B : never;

export interface Joiners {
  /** "A", "A and B", "A, B and C". */
  and(items: readonly (readonly Part[])[]): Part[];
  /** "A", "A or B", "A, B or C". */
  or(items: readonly (readonly Part[])[]): Part[];
}

export interface Phrasebook {
  lang: RulesTextLang;
  /** The raw template, for tests. */
  raw(key: PhraseKey): string;
  /** A sentence from a phrase key. */
  t(key: PhraseKey, args?: Readonly<Record<string, Arg>>): Part[];
  /** A phrase whose wording depends on a count (`key.one` for 1, `key.other` otherwise); `{n}` is filled in. */
  tn(base: PluralBase, n: number, args?: Readonly<Record<string, Arg>>): Part[];
  and: Joiners['and'];
  or: Joiners['or'];
}

const books: Record<RulesTextLang, { dict: Record<PhraseKey, string>; joiners: Joiners }> = {
  en: { dict: en, joiners: enJoiners },
  he: { dict: he, joiners: heJoiners },
};

/** Every phrase key, for the placeholder-consistency test. */
export const PHRASE_KEYS = Object.keys(en) as PhraseKey[];

export function phrasebook(lang: RulesTextLang): Phrasebook {
  const { dict, joiners } = books[lang];
  const t: Phrasebook['t'] = (key, args = {}) => fill(dict[key], args);
  return {
    lang,
    raw: (key) => dict[key],
    t,
    tn: (base, n, args = {}) => t(`${base}.${n === 1 ? 'one' : 'other'}` as PhraseKey, { n: String(n), ...args }),
    and: joiners.and,
    or: joiners.or,
  };
}
