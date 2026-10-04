// The pure parts of "convert a file" (SPEC 5 C, 21 v5 item 5): which rows need a look, what the user chose for each,
// the RowDecisions those choices become, and the counts a finished run reports. No React, no worker: easy to test.
import type { ConversionMatch, Flag, RowDecisions, RunSummary } from '@formatai/engine';
import { limits, type ColumnType, type LearnResult, type Rules, type SignatureEntry, type SourceConversionRef } from '@formatai/shared';
import type { MessageKey } from '../../i18n';
import type { RowInputCell, SignatureInput } from '../../worker/convertApi';

// ---------- rows to review ----------

export interface ReviewRow {
  /** 1-based, as shown in Excel. */
  rowNumber: number;
  /** The row's flags the user hasn't accepted yet, in the engine's order. */
  flags: Flag[];
  /** The check (severity "block") that leaves this row out of the file, when there is one. */
  blocked: { rule: string; column: string } | null;
}

/** Every row with something to look at, in row order: flagged rows, and rows a blocking check would leave out. */
export function reviewRows(flags: readonly Flag[], summary: RunSummary): ReviewRow[] {
  const byRow = new Map<number, ReviewRow>();
  const get = (rowNumber: number): ReviewRow => {
    let r = byRow.get(rowNumber);
    if (!r) byRow.set(rowNumber, (r = { rowNumber, flags: [], blocked: null }));
    return r;
  };
  for (const f of flags) if (f.accepted !== true) get(f.rowNumber).flags.push(f);
  for (const b of summary.blockedRows) get(b.rowNumber).blocked = { rule: b.rule, column: b.column };
  return [...byRow.values()].sort((a, b) => a.rowNumber - b.rowNumber);
}

/** A column id as the user knows it: the file's column (the rules' header), else the output column built from it, else the id. */
export function columnLabel(rules: LearnResult | Rules, id: string): string {
  const input = rules.input.columns.find((c) => c.id === id);
  if (input) return input.header;
  const out = rules.output.columns.find((c) => c.from === id || c.header === id);
  return out ? out.header : id;
}

/**
 * The input cells "Fix this row only" offers: the flagged input columns of the row. When the flag is about something
 * calculated (not an input column), the whole row's input columns are offered, since the value comes from one of them.
 */
export function fixFields(row: ReviewRow, cells: readonly RowInputCell[]): RowInputCell[] {
  const ids = new Set<string>();
  for (const f of row.flags) ids.add(f.column);
  if (row.blocked) ids.add(row.blocked.column);
  const flagged = cells.filter((c) => ids.has(c.columnId));
  return flagged.length > 0 ? flagged : [...cells];
}

// ---------- the user's choices ----------

/**
 * What the user chose for one row. `override` values are the text typed in the fields, keyed by input column id; `every` names the columns
 * whose typed fix the user also wants kept as a rule ("Do this every time?", SPEC 5 C): it is saved when the file is created.
 */
export type RowChoice = { action: 'skip' } | { action: 'keep' } | { action: 'override'; values: Record<string, string>; every?: string[] };
export type Choices = Record<number, RowChoice>;

/** The engine's RowDecisions (SPEC 21 v5 item 5). An emptied field is an empty cell. */
export function toRowDecisions(choices: Choices): RowDecisions {
  const out: RowDecisions = {};
  for (const [key, c] of Object.entries(choices)) {
    const row = Number(key);
    if (c.action === 'override') {
      const values: Record<string, string | null> = {};
      for (const [id, text] of Object.entries(c.values)) values[id] = text.trim() === '' ? null : text;
      out[row] = { action: 'override', values };
    } else out[row] = { action: c.action };
  }
  return out;
}

/** `choices` with this row's choice set, or taken away (`null`: undo). */
export function withChoice(choices: Choices, rowNumber: number, choice: RowChoice | null): Choices {
  const out = { ...choices };
  if (choice === null) delete out[rowNumber];
  else out[rowNumber] = choice;
  return out;
}

/** The same action for every row (the bulk buttons). A row the user already fixed by hand keeps its fix. */
export function applyToAll(rows: readonly ReviewRow[], action: 'keep' | 'skip', current: Choices): Choices {
  const out: Choices = {};
  for (const r of rows) {
    const existing = current[r.rowNumber];
    out[r.rowNumber] = existing?.action === 'override' ? existing : { action: action };
  }
  return out;
}

export interface Tally {
  keep: number;
  skip: number;
  fix: number;
  /** Rows with no choice: they are written as they are, highlighted (or left out, when a check blocks them). */
  open: number;
}

export function tally(rows: readonly ReviewRow[], choices: Choices): Tally {
  const t: Tally = { keep: 0, skip: 0, fix: 0, open: 0 };
  for (const r of rows) {
    const c = choices[r.rowNumber];
    if (!c) t.open++;
    else if (c.action === 'keep') t.keep++;
    else if (c.action === 'skip') t.skip++;
    else t.fix++;
  }
  return t;
}

// ---------- "Do this every time?" (SPEC 5 C, 8.4a): a typed fix of one cell becomes `readAs` on its column ----------

/** One fix the user can keep as a rule of the format: this exact text, in this input column, is read as `to` ("" = read as empty). */
export interface ReadAsFix {
  columnId: string;
  /** The column's header in the rules: what the user calls it. */
  header: string;
  /** The cell's exact text, as the file has it (not trimmed). */
  from: string;
  to: string;
}

/** What one typed field offers. */
export interface ReadAsOffer extends ReadAsFix {
  /** The rows of this review whose cell in the column has exactly this text (this one included): one "yes" covers them all. */
  rows: number;
  /** Another row of this review already keeps this text in this column as something else: a text is read one way only. */
  clash: boolean;
}

/** What a typed value is as the rule keeps it: nothing typed (or only spaces) means "read as empty", as an emptied field always did. */
export function typedReading(typed: string): string {
  return typed.trim() === '' ? '' : typed;
}

/**
 * The fix a typed field amounts to, when it can be a rule. DECISION: only a cell that IS text in the file (`RowInputCell.isText`: a number, a
 * date or an empty cell is never matched by `readAs`, so offering it would promise something next month's file would not do), whose text the
 * user changed, in a column that does not already read that text another way and has room for one more (`limits.rules.maxReadAsPerColumn`).
 */
function fixOf(rules: LearnResult | Rules, cell: RowInputCell | undefined, typed: string | undefined): ReadAsFix | null {
  if (!cell || typed === undefined || cell.isText !== true || typeof cell.value !== 'string' || cell.value === '') return null;
  const column = rules.input.columns.find((c) => c.id === cell.columnId);
  if (!column) return null;
  const to = typedReading(typed);
  if (to === cell.value) return null;
  const known = column.readAs ?? {};
  if (Object.prototype.hasOwnProperty.call(known, cell.value) || Object.keys(known).length >= limits.rules.maxReadAsPerColumn) return null;
  return { columnId: cell.columnId, header: column.header, from: cell.value, to };
}

/** The offer of one field of the fix editor as it is being typed (null: nothing to offer). `others` are the fixes the other rows already keep. */
export function readAsOffer(rules: LearnResult | Rules, cell: RowInputCell, typed: string, rowInputs: Readonly<Record<number, readonly RowInputCell[]>>, others: readonly ReadAsFix[]): ReadAsOffer | null {
  const fix = fixOf(rules, cell, typed);
  if (!fix) return null;
  const rows = Object.values(rowInputs).filter((cells) => cells.some((c) => c.columnId === fix.columnId && c.isText === true && c.value === fix.from)).length;
  const clash = others.some((o) => o.columnId === fix.columnId && o.from === fix.from && o.to !== fix.to);
  return { ...fix, rows: Math.max(rows, 1), clash };
}

/**
 * Every fix the user said "yes" to, once per (column, text): two rows that keep the same text as different values cancel each other (a text
 * is read one way only, and code does not pick for the user). `exceptRow` leaves one row out (what the OTHER rows keep).
 */
export function readAsFixes(rules: LearnResult | Rules, rowInputs: Readonly<Record<number, readonly RowInputCell[]>>, choices: Choices, exceptRow?: number): ReadAsFix[] {
  const found = new Map<string, ReadAsFix | null>();
  for (const [key, c] of Object.entries(choices)) {
    const row = Number(key);
    if (row === exceptRow || c.action !== 'override') continue;
    for (const columnId of c.every ?? []) {
      const fix = fixOf(rules, rowInputs[row]?.find((x) => x.columnId === columnId), c.values[columnId]);
      if (!fix) continue;
      const id = JSON.stringify([fix.columnId, fix.from]);
      const had = found.get(id);
      if (had === undefined) found.set(id, fix);
      else if (had !== null && had.to !== fix.to) found.set(id, null);
    }
  }
  return [...found.values()].filter((f): f is ReadAsFix => f !== null);
}

/**
 * The choices once `saved` fixes are rules: the cells they were typed for are no longer one-off fixes (the rule reads them now, here and next
 * month), so they leave the row decisions and the run really goes on with the new rule. A row left with no typed value has no decision.
 */
export function withoutSaved(choices: Choices, rowInputs: Readonly<Record<number, readonly RowInputCell[]>>, saved: readonly ReadAsFix[]): Choices {
  const out: Choices = {};
  for (const [key, c] of Object.entries(choices)) {
    const row = Number(key);
    if (c.action !== 'override' || !c.every || c.every.length === 0) {
      out[row] = c;
      continue;
    }
    const values = { ...c.values };
    const every: string[] = [];
    for (const columnId of c.every) {
      const original = rowInputs[row]?.find((x) => x.columnId === columnId)?.value;
      const kept = saved.some((s) => s.columnId === columnId && s.from === original && s.to === typedReading(values[columnId] ?? ''));
      if (kept) delete values[columnId];
      else every.push(columnId);
    }
    if (Object.keys(values).length > 0) out[row] = { action: 'override', values, ...(every.length > 0 ? { every } : {}) };
  }
  return out;
}

/** The rules with each fix added to its column's `readAs` (nothing else touched). */
export function withReadAs<R extends LearnResult | Rules>(rules: R, fixes: readonly ReadAsFix[]): R {
  if (fixes.length === 0) return rules;
  return {
    ...rules,
    input: {
      ...rules.input,
      columns: rules.input.columns.map((c) => {
        const mine = fixes.filter((f) => f.columnId === c.id);
        // Built from entries, never by assignment: a cell whose text is "__proto__" is a key like any other.
        return mine.length === 0 ? c : { ...c, readAs: Object.fromEntries([...Object.entries(c.readAs ?? {}), ...mine.map((f) => [f.from, f.to] as const)]) };
      }),
    },
  };
}

// ---------- counts of a finished run ----------

/** Rows with at least one flag the user hasn't accepted. */
export function flaggedRowCount(flags: readonly Flag[]): number {
  const rows = new Set<number>();
  for (const f of flags) if (f.accepted !== true) rows.add(f.rowNumber);
  return rows.size;
}

/** What POST /runs gets: counts only (SPEC 14.1, 15). */
export function runCounts(summary: RunSummary, flags: readonly Flag[]): { rows: number; flagged: number } {
  return { rows: summary.rowsIn, flagged: flaggedRowCount(flags) };
}

// ---------- sources and the formats they feed (SPEC 8.15) ----------

/**
 * The sources a page may run: every source that feeds at least one format (one with no conversion yet cannot run anything),
 * each with only the conversions this page may use - all of them, or, on `/convert?format=<id>`, the one that makes that format.
 */
export function scopeSources(entries: readonly SignatureEntry[], formatId: string | null): SignatureEntry[] {
  return entries.flatMap((e) => {
    const conversions = e.conversions.filter((c) => formatId === null || c.formatId === formatId);
    return conversions.length > 0 ? [{ ...e, conversions }] : [];
  });
}

/** What the worker's matcher takes: one signature per SOURCE (its id stands in for the "conversion id" the engine names it by). */
export function signatureOf(e: SignatureEntry): SignatureInput {
  return { id: e.sourceId, name: e.name, columns: e.columns, ...(e.ignoredHeaders && e.ignoredHeaders.length > 0 ? { ignoredHeaders: e.ignoredHeaders } : {}) };
}

/** The name of a file without its folder and extension ("Payments.xlsx" -> "Payments"). */
export function baseName(fileName: string): string {
  const stem = fileName.split(/[/\\]/).pop() ?? fileName;
  const dot = stem.lastIndexOf('.');
  return (dot > 0 ? stem.slice(0, dot) : stem) || 'output';
}

// ---------- formats that need the user's attention (SPEC 8.15, 21 v11 items 4-7) ----------

/**
 * Why a format cannot simply be made from this file, and what that leaves to the user. Nothing is changed for them: they open the
 * format's editor, skip it this time, or (when it can still run) make it anyway.
 */
export type Attention =
  /** The file lacks columns the format needs. `required` are the ones it cannot run without; the rest are used but optional (it runs, and leaves what they feed empty). */
  | { kind: 'missing'; columns: string[]; required: string[] }
  /** "Same name, different meaning": most of a used column's values did not parse as the type it was saved with. */
  | { kind: 'values'; columns: { header: string; type: ColumnType }[] };

/** The format needs the columns of these gaps (`missingInputColumns`), or nothing is missing (null). */
export function attentionOfGaps(gaps: readonly { header: string; required: boolean }[]): Attention | null {
  if (gaps.length === 0) return null;
  return { kind: 'missing', columns: gaps.map((g) => g.header), required: gaps.filter((g) => g.required).map((g) => g.header) };
}

/** What a run says about "same name, different meaning" (`unlikeColumns`), or null when its values look as before. */
export function attentionOfUnlike(unlike: readonly { header: string; type: ColumnType }[] | undefined): Attention | null {
  if (!unlike || unlike.length === 0) return null;
  return { kind: 'values', columns: unlike.map((u) => ({ header: u.header, type: u.type })) };
}

/** "Run anyway" is offered unless the format cannot run at all: a missing required column is the engine's refusal, not ours. */
export function canRunAnyway(attention: Attention): boolean {
  return attention.kind === 'values' || attention.required.length === 0;
}

/** Column names inside a sentence: each isolated and in quotes, comma separated ("'Qty', 'Price'"). */
export function quoteNames(names: readonly string[]): string {
  return names.map((n) => `'${isolate(n)}'`).join(', ');
}

/** The columns a missing-columns stop names: the ones the formats cannot run without, once each, in the order they were found. */
export function requiredAcross(attention: readonly Attention[]): string[] {
  const out: string[] = [];
  for (const a of attention) if (a.kind === 'missing') for (const h of a.required) if (!out.includes(h)) out.push(h);
  return out;
}

/**
 * The file's headers no column of the source knows (`extra`: after exact names, aliases and normalized names), that no rename the user
 * just confirmed used, and that nobody dismissed before (SPEC 8.15 "A new column in the file"). Header names only, in the file's order.
 */
export function newColumns(extra: readonly string[], mapping: Readonly<Record<string, string>>, ignored: readonly string[] = []): string[] {
  const used = new Set(Object.values(mapping));
  const dismissed = new Set(ignored.map(normalizeHeader));
  return extra.filter((h) => !used.has(h) && !dismissed.has(normalizeHeader(h)));
}

// ---------- matching, in plain words ----------

/** "Almost every column matches" and so on: the score (SPEC 8.12) said in words; the percentage goes next to it. */
export function matchWords(score: number): MessageKey {
  if (score >= 0.9) return 'conv.match.high';
  if (score >= 0.6) return 'conv.match.mid';
  if (score >= 0.3) return 'conv.match.low';
  return 'conv.match.faint';
}

/**
 * A header compared the way the engine's third matching step does, in the small: NFC, trimmed, lower-case. (The main thread
 * cannot load the engine at run time - it runs in the worker - so this is a local, deliberately simple copy.)
 */
export function normalizeHeader(header: string): string {
  return header.normalize('NFC').trim().toLowerCase();
}

/** The mapping key (a header of the SOURCE) that names this conversion's declared column: exact first, then normalized. */
function mappingKeyFor(header: string, keys: readonly string[]): string | undefined {
  if (keys.includes(header)) return header;
  const wanted = normalizeHeader(header);
  return wanted === '' ? undefined : keys.find((k) => normalizeHeader(k) === wanted);
}

/**
 * In-memory copy of the rules with each confirmed rename added as an alias of its column (the saved rules are not touched).
 * The mapping is keyed by the SOURCE's header (SPEC 8.15: the rename is one fact about the source); it is applied to every
 * conversion of that source that runs, finding each one's declared column by exact header, then by the normalized header.
 */
export function withAliases<R extends LearnResult | Rules>(rules: R, mapping: Readonly<Record<string, string>>): R {
  const keys = Object.keys(mapping);
  if (keys.length === 0) return rules;
  return {
    ...rules,
    input: {
      ...rules.input,
      columns: rules.input.columns.map((c) => {
        const key = mappingKeyFor(c.header, keys);
        const alias = key === undefined ? undefined : mapping[key];
        return alias === undefined || (c.aliases ?? []).includes(alias) ? c : { ...c, aliases: [...(c.aliases ?? []), alias] };
      }),
    },
  };
}

/** For the renamed-column step: the file's unknown headers to offer for one missing column, suggestions first. Headers the source already knew are not offered. */
export function mappingOptions(match: ConversionMatch, required: string): { suggested: string[]; others: string[] } {
  const suggested = match.renamedCandidates.find((r) => r.required === required)?.candidates ?? [];
  const seen = new Set(suggested);
  return { suggested: [...suggested], others: match.unknownExtra.filter((h) => !seen.has(h)) };
}

/** A format of a source with the columns of a file its rules need and the file lacks (`missingInputColumns`, as the worker's `columnGaps` gives them). */
export interface FormatGaps {
  conversion: SourceConversionRef;
  gaps: readonly { header: string }[];
}

/**
 * For each of these missing columns, the formats whose rules need it: it is required by them, or they use it though it is optional
 * (SPEC 21 v11 items 4-7). A column no format needs maps to an empty list. Headers are compared the way matching does (NFC, trimmed,
 * lower-case), keyed by the header as given.
 */
export function formatsNeeding(columns: readonly string[], checked: readonly FormatGaps[]): Map<string, SourceConversionRef[]> {
  const out = new Map<string, SourceConversionRef[]>();
  for (const column of columns) {
    const key = normalizeHeader(column);
    out.set(
      column,
      checked.filter((f) => f.gaps.some((g) => normalizeHeader(g.header) === key)).map((f) => f.conversion),
    );
  }
  return out;
}

/** A user-supplied name inside a sentence (a source, a column): isolated so a Hebrew name in an English sentence, or the reverse, never reorders the words around it. */
export function isolate(name: string): string {
  return `⁨${name}⁩`;
}
