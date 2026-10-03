// learn-v7 (issue #40, SPEC 8.10, 13, 15): what the API does with the two optional notes an AI answer may put on an `unsupported` entry.
//
//   * `explanation` - a plain-language GUESS at the rule, for the user's screen only. It goes back to the browser with the answer (masked,
//     like everything else in it) and is NEVER stored, cached, logged or saved: `stripAiNotes` (shared) takes it out before the structure
//     cache is written and before rules are saved to the registry; this file only validates it (a length cap, `dropInvalidNotes`).
//   * `functionRequest` - the function the language lacks, value-free by construction. Before it is stored it passes a VALUE FILTER: a request
//     whose name, purpose or argument names contain anything from the payload (a sample or dropped-row cell, a hint value - masked fakes or
//     real, whatever was sent) is REJECTED: counted, never stored, and removed from the answer. What passes is upserted into
//     `function_requests` (deduplicated on name + signature, counted per distinct HASHED owner, mapped to a catalogue topic).
//
// Nothing here ever fails or repairs a learn: a note is an extra, so a malformed one is dropped and a rejected one disappears.
import { createHmac } from 'node:crypto';
import {
  FunctionRequestSchema,
  limits,
  type FunctionRequest,
  type LearnPayload,
  type LearnResult,
  type PayloadCell,
} from '@formatai/shared';
import type { ProtectionStore } from '../protection/store.js';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ---------- structure: an invalid note is dropped, never a reason to repair ----------

/**
 * Raw answer JSON (formula text already decoded) with every malformed note removed from its `unsupported` entries: a `functionRequest`
 * that breaks the schema (name pattern, length caps, argument count, types) or an `explanation` that is not a non-empty string of at most
 * `limits.learn.notes.maxExplanationChars` characters. The rest of the answer is untouched, so the strict schema never rejects a learn
 * over an extra.
 */
export function dropInvalidNotes(json: unknown): unknown {
  if (!isRecord(json) || !Array.isArray(json.unsupported)) return json;
  let changed = false;
  const unsupported = json.unsupported.map((u): unknown => {
    if (!isRecord(u)) return u;
    const next: Record<string, unknown> = { ...u };
    if ('functionRequest' in next && !FunctionRequestSchema.safeParse(next.functionRequest).success) {
      delete next.functionRequest;
      changed = true;
    }
    if ('explanation' in next) {
      const e = next.explanation;
      if (typeof e !== 'string' || e.trim() === '' || e.length > limits.learn.notes.maxExplanationChars) {
        delete next.explanation;
        changed = true;
      }
    }
    return next;
  });
  return changed ? { ...json, unsupported } : json;
}

// ---------- the value filter ----------

/** Letter runs (Latin, Hebrew, any script) or number runs (digits with `.` or `,` inside). */
const TOKEN = /\p{N}+(?:[.,]\p{N}+)*|[\p{L}\p{M}]+/gu;

/** `sumByGroup` -> `sum By Group`, so the words inside an identifier are compared as words. */
function splitCamel(text: string): string {
  return text.replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2');
}

/** A number written any common way, one canonical form: `1,000.50` / `1000.5` / `001000.50` -> `1000.5`. */
export function canonicalNumber(raw: string): string {
  let s = raw;
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
  else s = s.replace(',', '.');
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  s = s.replace(/^0+(?=\d)/, '');
  return s === '' ? '0' : s;
}

/** The text tokens (lower-cased letter runs) and the numbers of one string. */
function tokensOf(text: string): { words: string[]; numbers: string[] } {
  const words: string[] = [];
  const numbers: string[] = [];
  for (const m of text.matchAll(TOKEN)) {
    const t = m[0];
    if (/^\p{N}/u.test(t)) numbers.push(canonicalNumber(t));
    else words.push(t.toLowerCase());
  }
  return { words, numbers };
}

/** Every value the payload carries, in the vocabulary the answer was written against (masked fakes when masking is on, real otherwise). */
export interface PayloadValues {
  /** Lower-cased words of at least `limits.learn.notes.minTokenChars` characters. */
  words: ReadonlySet<string>;
  /** Canonical numbers, of any length (digits inside text cells too). */
  numbers: ReadonlySet<string>;
}

function addCell(cell: unknown, into: { words: Set<string>; numbers: Set<string> }): void {
  if (typeof cell === 'number') {
    if (Number.isFinite(cell)) into.numbers.add(canonicalNumber(String(cell)));
    return;
  }
  if (typeof cell !== 'string') return;
  const { words, numbers } = tokensOf(cell);
  for (const w of words) if (w.length >= limits.learn.notes.minTokenChars) into.words.add(w);
  for (const n of numbers) into.numbers.add(n);
}

/** Hint fields that carry values (everything else in a hint is a position, a name or a number ABOUT the relation, not data). */
const HINT_VALUE_KEYS: ReadonlySet<string> = new Set(['pairs', 'value', 'keptValues', 'droppedValues', 'droppedWhen', 'bands', 'parts', 'const', 'lt', 'gte']);
/** Inside a value-carrying field these are structure again (`{ in: 3 }` in a template, `op` in a threshold). */
const HINT_STRUCTURE_KEYS: ReadonlySet<string> = new Set(['in', 'out', 'op']);

function addHintValues(node: unknown, into: { words: Set<string>; numbers: Set<string> }, collecting: boolean): void {
  if (Array.isArray(node)) {
    for (const v of node) addHintValues(v, into, collecting);
    return;
  }
  if (isRecord(node)) {
    for (const [k, v] of Object.entries(node)) {
      if (collecting) {
        if (!HINT_STRUCTURE_KEYS.has(k)) addHintValues(v, into, true);
      } else if (HINT_VALUE_KEYS.has(k)) addHintValues(v, into, true);
      else if (k === 'positions') addHintValues(v, into, false); // a fan-out's per-position hints
    }
    return;
  }
  if (collecting) addCell(node, into);
}

/** Collects the value tokens of the payload: sample cells (pairs and families), dropped rows, hint values and column value ranges. */
export function payloadValues(payload: LearnPayload): PayloadValues {
  const into = { words: new Set<string>(), numbers: new Set<string>() };
  for (const s of payload.samples) {
    for (const c of s.in as PayloadCell[]) addCell(c, into);
    for (const o of s.out as (PayloadCell | PayloadCell[])[]) {
      if (Array.isArray(o)) for (const c of o) addCell(c, into);
      else addCell(o, into);
    }
  }
  for (const row of payload.dropped ?? []) for (const c of row) addCell(c, into);
  for (const h of payload.hints) addHintValues(h, into, false);
  for (const col of [...payload.input.columns, ...payload.output.columns]) {
    for (const v of col.stats?.range ?? []) addCell(v, into);
  }
  return into;
}

/** The texts of a request that must carry no value: its name, its purpose and the names of its arguments. */
function requestTexts(req: FunctionRequest): string[] {
  return [req.name, req.purpose, ...req.args.map((a) => a.name)];
}

/** True when any word (of at least `minTokenChars` characters, case-insensitive) or number of the request's name, purpose or argument names is a value in the payload. */
export function requestMentionsPayloadValue(req: FunctionRequest, values: PayloadValues): boolean {
  for (const text of requestTexts(req)) {
    const plain = tokensOf(text);
    const split = tokensOf(splitCamel(text));
    for (const w of [...plain.words, ...split.words]) {
      if (w.length >= limits.learn.notes.minTokenChars && values.words.has(w)) return true;
    }
    for (const n of [...plain.numbers, ...split.numbers]) if (values.numbers.has(n)) return true;
  }
  return false;
}

// ---------- identity of a request ----------

/** `<normalized name>(<argument types>):<returns>` - the same function asked for twice (any argument names, any case) is one request. */
export function requestKey(req: FunctionRequest): string {
  return `${req.name.toLowerCase()}(${req.args.map((a) => a.type).join(',')}):${req.returns}`;
}

/** An owner as a keyed hash: what `function_requests` counts distinct owners by. The raw id is never stored. */
export function hashOwner(owner: string, secret: string): string {
  return createHmac('sha256', secret).update(`function-request-owner:${owner}`).digest('hex').slice(0, 24);
}

// ---------- topic ----------

/** Catalogue topics (`eval/catalogue/topics.ts`) and the words that point at them; the topic with the most hits wins, ties go to the first. */
const TOPIC_WORDS: readonly (readonly [string, readonly string[]])[] = [
  ['acrossRows', ['running', 'cumulative', 'previous', 'preceding', 'following', 'rank', 'row number', 'rolling', 'moving', 'lag', 'lead', 'percentile', 'neighbor', 'neighbour']],
  ['dates', ['date', 'day', 'month', 'year', 'week', 'quarter', 'calendar', 'age', 'timestamp', 'fiscal', 'holiday', 'תאריך', 'יום', 'חודש', 'שנה']],
  ['lookups', ['lookup', 'look up', 'table', 'mapping', 'translate', 'rate', 'dictionary', 'reference']],
  ['extraction', ['extract', 'substring', 'prefix', 'suffix', 'between', 'delimiter', 'split', 'position', 'characters', 'segment', 'token']],
  ['cleanup', ['trim', 'clean', 'strip', 'whitespace', 'normalize', 'normalise', 'accent', 'punctuation', 'diacritic', 'replace', 'remove', 'invisible', 'collapse']],
  ['formatting', ['format', 'pad', 'decimal places', 'currency', 'locale', 'display', 'zero-pad', 'leading zero', 'ordinal', 'in words', 'spell out']],
  ['combining', ['concatenate', 'join', 'combine', 'merge', 'template', 'full name', 'compose']],
  ['arithmetic', ['sum', 'average', 'median', 'mean', 'round', 'percent', 'ratio', 'product', 'multiply', 'divide', 'power', 'root', 'absolute', 'tax', 'vat', 'discount', 'compound', 'interest', 'modulo', 'remainder', 'standard deviation', 'variance']],
  ['logic', ['condition', 'conditional', 'boolean', 'whether', 'compare', 'validate', 'check']],
  ['rowOps', ['filter', 'duplicate', 'dedupe', 'sort', 'expand', 'rows', 'unpivot', 'transpose', 'repeat', 'explode']],
  ['structure', ['sheet', 'layout', 'header', 'column order', 'title', 'pivot', 'merge cells', 'heading']],
];

/** Best-effort catalogue topic of a request, from the words of its purpose and name; `unknown` when no word points anywhere. */
export function topicOfRequest(req: Pick<FunctionRequest, 'name' | 'purpose'>): string {
  const text = `${splitCamel(req.name)} ${req.purpose}`.toLowerCase();
  const words = [...text.matchAll(/[\p{L}\p{M}]+/gu)].map((m) => m[0]);
  let best = 'unknown';
  let bestHits = 0;
  for (const [topic, keywords] of TOPIC_WORDS) {
    let hits = 0;
    for (const kw of keywords) {
      if (kw.includes(' ')) {
        if (text.includes(kw)) hits += 1;
      } else if (words.some((w) => w === kw || (kw.length >= 4 && w.startsWith(kw)))) hits += 1;
    }
    if (hits > bestHits) {
      best = topic;
      bestHits = hits;
    }
  }
  return best;
}

// ---------- the pipeline an answer goes through ----------

export interface NotesContext {
  store: ProtectionStore;
  /** The HMAC secret (`protection.secret`). */
  secret: string;
  owner: string;
  now: Date;
  /** Requests (`requestKey`) this learn already recorded in an earlier answer (a repair of it): still allowed through, not counted again. */
  alreadyRecorded?: ReadonlySet<string>;
  /** A store failure is logged by name only (SPEC 15) and the request treated as not recorded. */
  onError?: (err: unknown) => void;
}

export interface NotesOutcome {
  /** The answer for the browser: explanations as they came (masked), and only the function requests that were kept. */
  rules: LearnResult;
  /** Requests newly written to `function_requests` by this answer. */
  recorded: number;
  /** Requests removed because they mentioned a payload value (counted, never stored). */
  rejected: number;
}

/** `fnreq:<what>:<yyyy-mm>`: how many requests were recorded / rejected this month (counts only). */
export const requestCounterKey = (what: 'recorded' | 'rejected', now: Date): string => `fnreq:${what}:${now.toISOString().slice(0, 7)}`;

/**
 * The function requests of a (schema-valid) answer, filtered and recorded: those that mention a payload value are rejected and counted;
 * the rest are upserted into `function_requests` (once per distinct request per answer). Returns the answer with the rejected requests
 * (and any whose recording failed) removed from it. The explanations are left alone here - they never reach the store, and the browser
 * is the only place that shows them.
 */
export async function recordFunctionRequests(rules: LearnResult, payload: LearnPayload, ctx: NotesContext): Promise<NotesOutcome> {
  if (!rules.unsupported.some((u) => u.functionRequest !== undefined)) return { rules, recorded: 0, rejected: 0 };
  const values = payloadValues(payload);
  const ownerHash = hashOwner(ctx.owner, ctx.secret);
  let recorded = 0;
  let rejected = 0;
  const seen = new Set<string>();
  const unsupported: LearnResult['unsupported'] = [];
  for (const u of rules.unsupported) {
    const req = u.functionRequest;
    if (req === undefined) {
      unsupported.push(u);
      continue;
    }
    const { functionRequest: _dropped, ...withoutRequest } = u;
    if (requestMentionsPayloadValue(req, values)) {
      rejected += 1;
      unsupported.push(withoutRequest);
      continue;
    }
    const key = requestKey(req);
    let keep = true;
    if (!seen.has(key) && !ctx.alreadyRecorded?.has(key)) {
      try {
        await ctx.store.upsertFunctionRequest({
          key,
          name: req.name,
          purpose: req.purpose,
          args: req.args.map((a) => ({ name: a.name, type: a.type })),
          returns: req.returns,
          topic: topicOfRequest(req),
          ownerHash,
          now: ctx.now,
        });
        recorded += 1;
      } catch (err) {
        ctx.onError?.(err);
        keep = false;
      }
    }
    seen.add(key);
    unsupported.push(keep ? u : withoutRequest);
  }
  // Counts only (SPEC 15): how many were kept and how many refused.
  try {
    if (recorded > 0) await ctx.store.incrementCounter(requestCounterKey('recorded', ctx.now), recorded);
    if (rejected > 0) await ctx.store.incrementCounter(requestCounterKey('rejected', ctx.now), rejected);
  } catch (err) {
    ctx.onError?.(err);
  }
  return { rules: { ...rules, unsupported }, recorded, rejected };
}

/** The `requestKey`s of the function requests an answer already carries (a repair's `previousRules`). */
export function requestKeysOf(rules: Pick<LearnResult, 'unsupported'>): Set<string> {
  const keys = new Set<string>();
  for (const u of rules.unsupported) if (u.functionRequest !== undefined) keys.add(requestKey(u.functionRequest));
  return keys;
}
