// learn-v7 (issue #40, SPEC 8.10, 15): the two optional notes an AI answer may put on an `unsupported` entry - a value-free FUNCTION
// REQUEST and a plain-language EXPLANATION (a guess, in-session only). The privacy rule is one sentence: neither is ever stored, cached,
// logged or saved with the rules. Everything that writes rules anywhere (the structure cache, the registry, the browser's own storage, the
// payload of a later call) goes through `stripAiNotes` first; the browser keeps the notes apart from the rules (`aiNotesOf`) and shows them
// for the session only.
import type { Unsupported } from './schema';

/** What the session keeps of the notes of one unsupported column (never saved; see the file header). */
export interface AiColumnNote {
  /** The output column's header. */
  header: string;
  /** The AI step's plain-language guess at the rule (real words: the browser unmasked it). */
  explanation?: string;
  /** A function request for this column was recorded (the API answers with the request only when it kept it). */
  functionRecorded?: boolean;
}

function hasNotes(u: Unsupported): boolean {
  return u.explanation !== undefined || u.functionRequest !== undefined;
}

/** `rules` with `explanation` and `functionRequest` removed from every `unsupported` entry. Returns `rules` itself when there is nothing to remove. */
export function stripAiNotes<T extends { unsupported: Unsupported[] }>(rules: T): T {
  // (defensive: a boundary helper - something that is not rules-shaped is returned as it is)
  if (!Array.isArray(rules.unsupported) || !rules.unsupported.some(hasNotes)) return rules;
  return {
    ...rules,
    unsupported: rules.unsupported.map((u) => {
      if (!hasNotes(u)) return u;
      const { explanation: _explanation, functionRequest: _functionRequest, ...rest } = u;
      return rest;
    }),
  };
}

/** The notes of an (unmasked) answer, per output header, for the session. Entries with neither note are left out. */
export function aiNotesOf(rules: { unsupported: Unsupported[] }): AiColumnNote[] {
  const notes: AiColumnNote[] = [];
  if (!Array.isArray(rules.unsupported)) return notes;
  for (const u of rules.unsupported) {
    if (!hasNotes(u)) continue;
    const explanation = u.explanation?.trim();
    notes.push({
      header: u.outputColumn,
      ...(explanation ? { explanation } : {}),
      ...(u.functionRequest !== undefined ? { functionRecorded: true } : {}),
    });
  }
  return notes;
}

/** Strips the notes from every rules-shaped value it can find at the top level of an unknown JSON value (a saved body, a cached object). */
export function stripAiNotesFromJson(json: unknown): unknown {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return json;
  const o = json as Record<string, unknown>;
  if (!Array.isArray(o.unsupported)) return json;
  return {
    ...o,
    unsupported: o.unsupported.map((u) => {
      if (typeof u !== 'object' || u === null || Array.isArray(u)) return u;
      const { explanation: _explanation, functionRequest: _functionRequest, ...rest } = u as Record<string, unknown>;
      return rest;
    }),
  };
}
