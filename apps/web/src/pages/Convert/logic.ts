// The pure parts of "convert a file" (SPEC 5 C, 21 v5 item 5): which rows need a look, what the user chose for each,
// the RowDecisions those choices become, and the counts a finished run reports. No React, no worker: easy to test.
import type { ConversionMatch, Flag, RowDecisions, RunSummary } from '@formatai/engine';
import type { LearnResult, Rules } from '@formatai/shared';
import type { MessageKey } from '../../i18n';
import type { RowInputCell } from '../../worker/convertApi';

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

/** What the user chose for one row. `override` values are the text typed in the fields, keyed by input column id. */
export type RowChoice = { action: 'skip' } | { action: 'keep' } | { action: 'override'; values: Record<string, string> };
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

// ---------- matching, in plain words ----------

/** "Almost every column matches" and so on: the score (SPEC 8.12) said in words; the percentage goes next to it. */
export function matchWords(score: number): MessageKey {
  if (score >= 0.9) return 'conv.match.high';
  if (score >= 0.6) return 'conv.match.mid';
  if (score >= 0.3) return 'conv.match.low';
  return 'conv.match.faint';
}

/** In-memory copy of the rules with each confirmed rename added as an alias of its column (the saved rules are not touched). */
export function withAliases<R extends LearnResult | Rules>(rules: R, mapping: Readonly<Record<string, string>>): R {
  return {
    ...rules,
    input: {
      ...rules.input,
      columns: rules.input.columns.map((c) => {
        const alias = mapping[c.header];
        return alias === undefined || (c.aliases ?? []).includes(alias) ? c : { ...c, aliases: [...(c.aliases ?? []), alias] };
      }),
    },
  };
}

/** For the renamed-column step: the file's unknown headers to offer for one missing column, suggestions first. */
export function mappingOptions(match: ConversionMatch, required: string): { suggested: string[]; others: string[] } {
  const suggested = match.renamedCandidates.find((r) => r.required === required)?.candidates ?? [];
  const seen = new Set(suggested);
  return { suggested: [...suggested], others: match.extra.filter((h) => !seen.has(h)) };
}

/** A user-supplied name inside a sentence (a source, a column): isolated so a Hebrew name in an English sentence, or the reverse, never reorders the words around it. */
export function isolate(name: string): string {
  return `⁨${name}⁩`;
}
