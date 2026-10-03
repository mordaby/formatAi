// Matching a file to a conversion (SPEC 8.12, flow C, detection in A2): the browser compares the file's
// headers with each conversion's input signature - exact, then aliases, then normalized headers, exactly
// as the engine reads a file (SPEC 8.2 step 1, `mapHeaders`, so a match here is a match when it runs).
//
//   score = share of REQUIRED columns found, minus a small penalty per extra unknown column
//   (config `limits.matching`, DECISION 10).
//
// One conversion with a score >= 0.9 and at least 0.1 above the next is picked automatically; otherwise the
// user picks from the top 3. Never run automatically on a guess below the threshold. Pure and
// deterministic; only headers are looked at, never data.
import type { ColumnType, InputColumn } from '@formatai/shared';
import { limits } from '@formatai/shared';
import { mapHeaders } from '../pipeline/v1/normalize';
import { normalizeText } from '../values/text';

export interface SignatureColumnInput {
  header: string;
  aliases: string[];
  /** Not used for matching (only headers are known here); carried because it is part of the signature. */
  type: string;
  required: boolean;
}

export interface ConversionSignatureInput {
  id: string;
  name: string;
  columns: SignatureColumnInput[];
  /**
   * Headers this kind of file is already known to carry that no column of it reads (a source's `ignoredHeaders`, SPEC 8.15): never offered as
   * a renamed column. Compared like the engine's normalized header step (NFC, spacing, case). Names only.
   */
  ignoredHeaders?: string[];
}

export interface RenamedCandidates {
  /** A required column of the conversion that the file doesn't have. */
  required: string;
  /** File headers no column of the conversion claimed that look like it (most similar first). Empty when none does. */
  candidates: string[];
}

export interface ConversionMatch {
  id: string;
  name: string;
  /** 0..1: share of required columns found (all columns when the conversion declares none as required),
   * minus the extra-column penalty. */
  score: number;
  /** Required columns of the conversion the file doesn't have, by exact header, alias or normalized header. */
  missingRequired: string[];
  /** File headers that no column of the conversion matches (empty headers are ignored). */
  extra: string[];
  /** `extra` without the headers the signature already knows (`ignoredHeaders`): the only ones a missing column may have been renamed to. */
  unknownExtra: string[];
  /** For every missing required column: the extra file headers it may have been renamed to. */
  renamedCandidates: RenamedCandidates[];
}

export type ConversionPick =
  /** One conversion clearly matches: select it. `match.missingRequired` may still list a column (a score of
   * 0.9 allows for it); the caller must handle that, since the conversion can't run without it. */
  | { kind: 'auto'; match: ConversionMatch }
  /** The user picks; at most `limits.matching.maxSuggestions`, best first, none with a score of 0. */
  | { kind: 'choose'; options: ConversionMatch[] };

const EPS = 1e-9;

function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

// ---------------------------------------------------------------------------
// Header similarity (only to suggest a renamed column; never decides a match)
// ---------------------------------------------------------------------------

const NON_WORD = /[^\p{L}\p{N}]+/gu;

function fusedKey(s: string): string {
  return normalizeText(s).toLowerCase().replace(NON_WORD, '');
}

function tokens(s: string): string[] {
  return normalizeText(s)
    .toLowerCase()
    .split(NON_WORD)
    .filter((t) => t !== '');
}

function bigrams(s: string): Map<string, number> {
  const out = new Map<string, number>();
  const chars = Array.from(s);
  for (let i = 0; i + 1 < chars.length; i++) {
    const g = chars[i]! + chars[i + 1]!;
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
}

/**
 * 0..1: how likely `b` is a renamed `a`. 1 when they differ only by case, spacing, quotes or punctuation
 * ("Item-Code" / "item code"); 0.8 when one contains the other ("Price" / "Unit Price"); otherwise the
 * better of the character-bigram and word-overlap scores.
 */
export function headerSimilarity(a: string, b: string): number {
  const fa = fusedKey(a);
  const fb = fusedKey(b);
  if (fa === '' || fb === '') return 0;
  if (fa === fb) return 1;
  const [short, long] = fa.length <= fb.length ? [fa, fb] : [fb, fa];
  let best = short.length >= 3 && long.includes(short) ? 0.8 : 0;

  const ba = bigrams(fa);
  const bb = bigrams(fb);
  let overlap = 0;
  let sizeA = 0;
  let sizeB = 0;
  for (const n of ba.values()) sizeA += n;
  for (const n of bb.values()) sizeB += n;
  for (const [g, n] of ba) overlap += Math.min(n, bb.get(g) ?? 0);
  if (sizeA + sizeB > 0) best = Math.max(best, (2 * overlap) / (sizeA + sizeB));

  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  const union = ta.size + tb.size - shared;
  if (union > 0) best = Math.max(best, shared / union);
  return best;
}

function renamedCandidatesFor(col: SignatureColumnInput, extra: readonly string[]): string[] {
  const names = [col.header, ...col.aliases].filter((n) => n !== '');
  const scored: { header: string; sim: number; at: number }[] = [];
  extra.forEach((h, at) => {
    let sim = 0;
    for (const n of names) sim = Math.max(sim, headerSimilarity(n, h));
    if (sim >= limits.matching.minRenamedSimilarity) scored.push({ header: h, sim, at });
  });
  scored.sort((x, y) => y.sim - x.sim || x.at - y.at);
  return scored.slice(0, limits.matching.maxRenamedCandidates).map((c) => c.header);
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/** A header compared the way the engine's third matching step does (`mapHeaders`): NFC, spacing, case. */
function knownKey(s: string): string {
  return normalizeText(s).toLowerCase();
}

function matchOne(fileHeaders: readonly string[], sig: ConversionSignatureInput): ConversionMatch {
  // The engine's own header mapping (exact, then aliases, then normalized), so this can't disagree with a run.
  const asColumns: InputColumn[] = sig.columns.map((c, i) => ({
    id: `c${i}`,
    header: c.header,
    aliases: c.aliases,
    type: 'text' as ColumnType,
    required: c.required,
  }));
  const { src } = mapHeaders(asColumns, [...fileHeaders]);

  const claimed = new Set<number>();
  for (const s of src) if (s >= 0) claimed.add(s);
  const extra = fileHeaders.filter((h, i) => !claimed.has(i) && h.trim() !== '');
  // DECISION: a header the source already knew (it sat in the example next to the columns the rules read, or the user dismissed it as a "new
  // column") is not a renamed column: "City" beside "Phone" in the example is not a renamed "Phone". It stays in `extra`, but is not
  // offered as a rename, neither as a suggestion nor among the others (`unknownExtra`), and it costs no extra-column penalty: the source
  // knows it, so a file that has it is no less this source's file.
  const known = new Set((sig.ignoredHeaders ?? []).map(knownKey));
  const unknownExtra = extra.filter((h) => !known.has(knownKey(h)));

  const requiredIdx = sig.columns.flatMap((c, i) => (c.required ? [i] : []));
  const scoring = requiredIdx.length > 0 ? requiredIdx : sig.columns.map((_, i) => i);
  const found = scoring.filter((i) => src[i]! >= 0).length;
  const base = scoring.length === 0 ? 0 : found / scoring.length;
  const penalty = Math.min(unknownExtra.length * limits.matching.extraColumnPenalty, limits.matching.maxExtraPenalty);

  const missing = requiredIdx.filter((i) => src[i]! < 0).map((i) => sig.columns[i]!);
  return {
    id: sig.id,
    name: sig.name,
    score: round6(Math.max(0, base - penalty)),
    missingRequired: missing.map((c) => c.header),
    extra,
    unknownExtra,
    renamedCandidates: missing.map((c) => ({ required: c.header, candidates: renamedCandidatesFor(c, unknownExtra) })),
  };
}

/**
 * Ranks every conversion signature against a file's headers, best first (ties: fewer missing required
 * columns, then fewer extra columns, then id). Every signature is returned, including score 0.
 */
export function matchConversions(fileHeaders: readonly string[], signatures: readonly ConversionSignatureInput[]): ConversionMatch[] {
  const matches = signatures.map((sig) => matchOne(fileHeaders, sig));
  return matches.sort(
    (a, b) =>
      b.score - a.score ||
      a.missingRequired.length - b.missingRequired.length ||
      a.extra.length - b.extra.length ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/**
 * SPEC 8.12 / DECISION 10: the top match is selected automatically when its score is at least
 * `limits.matching.autoScore` and it is at least `autoMargin` above the next one; otherwise the user
 * picks from the top `maxSuggestions`. `ranked` is `matchConversions`'s output.
 */
export function pickConversion(ranked: readonly ConversionMatch[]): ConversionPick {
  const top = ranked[0];
  const next = ranked[1];
  if (top !== undefined && top.score >= limits.matching.autoScore - EPS && (next === undefined || top.score - next.score >= limits.matching.autoMargin - EPS)) {
    return { kind: 'auto', match: top };
  }
  return { kind: 'choose', options: ranked.filter((m) => m.score > 0).slice(0, limits.matching.maxSuggestions) };
}
