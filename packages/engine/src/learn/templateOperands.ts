// What the local builders need to know before they write a `template` relation (analyze/relations.ts)
// as a rule: the analysis compared the output with the TRIMMED text of each input value, but the engine
// hands a computed column the value as it reads the declared column - a text column untrimmed, an id
// column trimmed, a number as its plain decimal text. A template is only built when, on every aligned
// row, the engine's text for each operand is provably the text the analysis saw (or becomes it with a
// `trim` / `toText` around the column); otherwise the column is left to the AI step.

import type { ColumnType } from '@formatai/shared';
import type Decimal from 'decimal.js';
import { fromExcelNumber, parseNumber } from '../values/numbers';
import { canonNum } from './analyze/cells';
import type { PairAnalysis } from './analyze';

/** How the operand column goes into the rule's `concat`: as it is, inside `trim(...)`, or inside `toText(...)`. */
export type OperandForm = 'plain' | 'trim' | 'toText';

const NUMERIC_TYPES: ReadonlySet<ColumnType> = new Set<ColumnType>(['integer', 'decimal', 'currency', 'percent']);

function decText(d: Decimal): string {
  return d.isZero() ? '0' : d.toFixed();
}

/** The engine's `trim`: strips the ends and collapses inner whitespace runs to one space. */
function excelTrim(s: string): string {
  return s.trim().replace(/\s+/g, ' ');
}

/**
 * The form in which input column `i` (declared as `declared`, with no zero padding) can be read by a
 * template, or null when the engine's text would differ from the analysis's on some aligned row.
 */
export function templateOperandForm(analysis: PairAnalysis, i: number, declared: ColumnType): OperandForm | null {
  const isText = declared === 'text';
  const isId = declared === 'idLike';
  const isNumber = NUMERIC_TYPES.has(declared);
  if (!isText && !isId && !isNumber) return null;
  let plain = true;
  let trimmed = isText;
  for (const { in: inRow } of analysis.alignment.rows) {
    const cell = analysis.input.rows[inRow]?.[i];
    const v = cell?.v;
    if (v === null || v === undefined) continue;
    if (typeof v === 'boolean' || cell?.isDate === true) return null;
    if (typeof v === 'string') {
      if (v.trim() === '') continue;
      const seen = v.trim(); // what the analysis compared
      if (isText) {
        if (v !== seen) plain = false;
        if (excelTrim(v) !== seen) trimmed = false;
      } else if (isId) {
        // idLike: the engine trims the cell.
      } else {
        const d = parseNumber(v);
        if (d === null || decText(d) !== seen) return null;
      }
      continue;
    }
    // A number cell: the analysis saw its canonical text, the engine sees the plain decimal of the same number.
    if (!Number.isFinite(v)) return null;
    const d = fromExcelNumber(v);
    if (decText(d) !== canonNum(v)) return null;
    if (isId && !d.isInteger()) return null;
  }
  if (isNumber) return 'toText';
  if (plain) return 'plain';
  return trimmed ? 'trim' : null;
}

/** The largest number of distinct non-empty (trimmed) values any of the columns takes over the aligned rows, capped at `cap`. */
export function maxDistinctValues(analysis: PairAnalysis, columns: readonly number[], cap: number): number {
  let best = 0;
  for (const i of columns) {
    const seen = new Set<string>();
    for (const { in: inRow } of analysis.alignment.rows) {
      const v = analysis.input.rows[inRow]?.[i]?.v;
      if (v === null || v === undefined) continue;
      const t = typeof v === 'string' ? v.trim() : typeof v === 'number' ? canonNum(v) : String(v);
      if (t === '') continue;
      seen.add(t);
      if (seen.size >= cap) return cap;
    }
    best = Math.max(best, seen.size);
  }
  return best;
}
