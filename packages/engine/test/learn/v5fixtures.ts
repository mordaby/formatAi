// Synthetic, domain-neutral example pairs for the v5 tests (partial result, readiness gate, learn flow).
// Each builder returns plain rows (header row first) so a test can turn them into in-memory workbooks
// (`xlsx`, for analysis-level tests) or real .xlsx bytes (`xlsxBytes`, for `learnFromExamples`).
import type { Tier } from '@formatai/shared';
import { writeXlsx } from '../../src/io/writeXlsx';
import type { OutRow, OutputSheet } from '../../src/types';
import { analyzeOk, rng, xlsx, type V } from './analyze/helpers';
import { preflight } from '../../src/learn/preflight';

export interface Pair {
  input: V[][];
  output: V[][];
}

const WORDS = ['Alpha', 'Bravo', 'Cedar', 'Delta', 'Ember', 'Falcon', 'Granite', 'Harbor', 'Indigo', 'Juniper', 'Kestrel', 'Lantern', 'Meadow', 'Nimbus', 'Orchid', 'Prairie', 'Quartz', 'Ripple', 'Summit', 'Tundra', 'Umber', 'Violet', 'Willow', 'Xenon'];
const GROUPS = ['North', 'South', 'East'];

/** The input rows the mixed pairs share: Ref (text id), Item, Qty, Price, Group. Not additive, so no row looks like a footer. */
function baseRows(n: number): V[][] {
  const rows: V[][] = [['Ref', 'Item', 'Qty', 'Price', 'Group']];
  for (let i = 0; i < n; i++) {
    rows.push([`R-${1000 + i * 7}`, `${WORDS[i % WORDS.length]} ${i}`, 1 + ((i * 3) % 9), 5 + ((i * 13) % 40) + 0.5 * (i % 3), GROUPS[i % 3]!]);
  }
  return rows;
}

/**
 * Columns of three kinds: `Item`, `Ref` (copies) and `Total` (Qty x Price) are fully explained by code; `Label`
 * is a copy of Group with ONE row edited by hand, so code only gets it right on 95% of rows (it needs the AI
 * step); `Warehouse` holds values that appear nowhere in the input (external data).
 */
export function mixedPair(n = 20): Pair {
  const input = baseRows(n);
  const r = rng(11);
  const output: V[][] = [['Item', 'Ref', 'Total', 'Label', 'Warehouse']];
  for (let i = 1; i <= n; i++) {
    const [ref, item, qty, price, group] = input[i] as [string, string, number, number, string];
    const total = Math.round(qty * price * 100) / 100;
    output.push([item, ref, total, i === 8 ? 'Special' : group, `W${100 + Math.floor(r() * 800)}`]);
  }
  return { input, output };
}

/** Everything is explained by code except `Warehouse`, whose values come from somewhere else (external data). */
export function externalOnlyPair(n = 20): Pair {
  const { input, output } = mixedPair(n);
  return { input, output: output.map((row) => [row[0]!, row[1]!, row[2]!, row[4]!]) };
}

/** Everything is explained by code and rows stay one-to-one: the strict fast path finishes it. */
export function simplePair(n = 20): Pair {
  const { input, output } = mixedPair(n);
  return { input, output: output.map((row) => [row[0]!, row[1]!, row[2]!]) };
}

/** A pair with no relation between the files: nothing in the output matches a row of the input (and the row counts
 * differ, so not even the row order can align them). */
export function unrelatedPair(n = 10): Pair {
  const input: V[][] = [['Ref', 'Name']];
  const output: V[][] = [['Code', 'Title']];
  for (let i = 0; i < n; i++) input.push([`IN-${i * 11 + 3}`, `Input ${WORDS[i]}`]);
  for (let i = 0; i < n - 3; i++) output.push([`OUT-${i * 17 + 5}`, `Output ${WORDS[(i + 7) % WORDS.length]}`]);
  return { input, output };
}

/** Rows that expand: one output row per month column (Dept / Month / Amount). `sorted` adds a sort the code can't build. */
export function columnsToRowsPair(opts: { sorted?: boolean } = {}): Pair {
  const depts = ['Sales', 'Support', 'Ops', 'Legal', 'Design', 'Research'];
  const input: V[][] = [['Dept', 'Jan', 'Feb', 'Mar']];
  const out: [string, string, number][] = [];
  depts.forEach((d, i) => {
    const vals = [100 + i * 37, 80 + i * 11, 60 + i * 5];
    input.push([d, ...vals]);
    ['Jan', 'Feb', 'Mar'].forEach((m, k) => out.push([d, m, vals[k]!]));
  });
  if (opts.sorted) out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return { input, output: [['Dept', 'Month', 'Amount'], ...out] };
}

/** Rows that expand: one output row per part of a `;`-separated cell. */
export function splitCellPair(): Pair {
  const tagsFor = [['red', 'blue'], ['green'], ['red', 'green', 'gold'], ['blue', 'gold'], ['green', 'blue'], ['red']];
  const input: V[][] = [['Ref', 'Tags', 'Amount']];
  const output: V[][] = [['Ref', 'Tag']];
  tagsFor.forEach((tags, i) => {
    input.push([`T-${200 + i * 9}`, tags.join(';'), 10 + i * 7]);
    for (const t of tags) output.push([`T-${200 + i * 9}`, t]);
  });
  return { input, output };
}

/** One output row per group, with aggregates: a summary, which code can't build (needs the AI step). */
export function summaryPair(): Pair {
  const input: V[][] = [['Ref', 'Group', 'Amount']];
  const totals = new Map<string, number>();
  for (let i = 0; i < 18; i++) {
    const g = ['North', 'South', 'East'][i % 3]!;
    const amount = 10 + ((i * 7) % 23);
    input.push([`S-${300 + i * 5}`, g, amount]);
    totals.set(g, (totals.get(g) ?? 0) + amount);
  }
  return { input, output: [['Group', 'Total'], ...[...totals].map(([g, t]): V[] => [g, t])] };
}

/** Rows sorted by a column in the example (a layout part code doesn't build), otherwise a plain copy. */
export function sortedPair(n = 12): Pair {
  const { input } = mixedPair(n);
  const rows = input.slice(1).map((r): V[] => [r[1]!, r[0]!]);
  rows.sort((a, b) => ((a[0] as string) < (b[0] as string) ? -1 : (a[0] as string) > (b[0] as string) ? 1 : 0));
  // reverse the order relative to the input so a sort is detected
  rows.reverse();
  return { input, output: [['Item', 'Ref'], ...rows] };
}

export function analyzeOf(pair: Pair) {
  return analyzeOk(xlsx(pair.input), xlsx(pair.output));
}

export function analyzeWithPreflight(pair: Pair, tier: Tier = 'paid') {
  const a = analyzeOf(pair);
  return { a, pf: preflight(a, tier) };
}

/** Real .xlsx bytes for `learnFromExamples`. */
export async function xlsxBytesOf(rows: V[][]): Promise<Uint8Array> {
  const cellV = (v: V): string | number | boolean | null => (v !== null && typeof v === 'object' ? v.v : v);
  const [head, ...body] = rows;
  const headers = (head ?? []).map((h) => String(cellV(h)));
  const sheet: OutputSheet = {
    name: 'Sheet1',
    direction: 'ltr',
    language: 'en',
    columns: headers.map((h) => ({ header: h })),
    rows: [
      { kind: 'header', cells: headers.map((h) => ({ v: h })) } as OutRow,
      ...body.map((r): OutRow => ({ kind: 'data', cells: r.map((v) => ({ v: cellV(v) })) })),
    ],
    merges: [],
  };
  return writeXlsx(sheet);
}
