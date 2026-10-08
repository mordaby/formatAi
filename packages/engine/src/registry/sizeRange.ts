// The size of a number column (SPEC 5 C, 8.15, owner decision 2026-10-08): "same name, different SIZE".
//
// Two senders can use one column name for different things - "Total" is money in the thousands for one, a count of 1-50 for another. Both parse
// as numbers, so the type check (`unlikeColumns`) cannot tell. Each CONVERSION therefore keeps a coarse range per number column its rules use,
// `input.columns[].range = { lo, hi }`: the decade exponents (floor(log10 |v|)) of the 10th and 90th percentile of the non-zero absolute values
// the example input had. Two small integers - never a value, never a min or max. A later file whose column is far outside it (its MEDIAN more
// than `limits.matching.sizeMarginDecades` decades away) puts that format under "Needs attention" on the Run screen; nothing is changed.
//
//   - `sizeRangesOf` / `withSizeRanges`: the range of an example, written at the END of a learn (flow.ts), after every AI round - so the AI step
//     is never sent it (the wire schema leaves it out as well).
//   - `sizeGapsOf` / `fileSizeGaps`: a file against the saved ranges, for the Run screen (the worker's `sizeGaps`).
//
// DECISION: the values are read with the code a run reads them with - `mapHeaders` for the column, `readCell` for `readAs`, `colNorm` +
// `normalizeCell` for the number - so a check can never disagree with a run about what a cell holds. A cell that does not parse, or is empty, is
// not a value here (the run flags it; the type check is `unlikeColumns`'s business). Used columns only (`inputColumnsUsed`): a column nothing
// reads is no part of what the format means by its numbers.
import Decimal from 'decimal.js';
import { isNumberColumnType, limits, type InputColumn, type LearnResult, type Rules, type SizeRange } from '@formatai/shared';
import { extractTable } from '../io/extractTable';
import { colNorm, mapHeaders, newIssue, normalizeCell, readAsOf, readCell } from '../pipeline/v1/normalize';
import type { InputTable, RawWorkbook } from '../types';
import { inputColumnsUsed } from './inputColumnsUsed';

type RulesLike = LearnResult | Rules;

/** floor(log10 |v|) of a non-zero decimal: the exponent of its leading digit, exact (no float log). */
export const decadeOf = (v: Decimal): number => v.e;

/**
 * The non-zero absolute values of one file column, ascending, read the way a run reads them. Empty cells, zeros and cells that do not parse as a
 * number are left out.
 */
export function magnitudesOf(column: InputColumn, sourceIndex: number, table: InputTable, language: 'he' | 'en'): Decimal[] {
  if (sourceIndex < 0) return [];
  const norm = colNorm(column, table.date1904 === true, language);
  const reads = readAsOf(column);
  const issue = newIssue();
  const out: Decimal[] = [];
  for (const row of table.rows) {
    const val = normalizeCell(readCell(row[sourceIndex], reads), norm, issue);
    // A cell that does not parse stays text (the run flags it); a whole-number column's 12.5 is still the number it is.
    if (!(val instanceof Decimal)) continue;
    const d = val.abs();
    if (d.isFinite() && !d.isZero()) out.push(d);
  }
  return out.sort((a, b) => a.cmp(b));
}

/** The value at the `p`th percentile of `sorted` (ascending, not empty), nearest rank - integer arithmetic, so 10% of 30 values is exactly the 3rd. */
function atPercentile(sorted: readonly Decimal[], p: number): Decimal {
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p * sorted.length) / 100)));
  return sorted[rank - 1] as Decimal;
}

/** The size range of ascending magnitudes; null with fewer than `limits.matching.sizeMinValues` of them (nothing is claimed from so little). */
export function sizeRangeOfMagnitudes(sorted: readonly Decimal[]): SizeRange | null {
  if (sorted.length < limits.matching.sizeMinValues) return null;
  const clamp = (n: number): number => Math.min(limits.matching.sizeMaxExponent, Math.max(limits.matching.sizeMinExponent, n));
  const lo = clamp(decadeOf(atPercentile(sorted, limits.matching.sizeLowPercentile)));
  const hi = clamp(decadeOf(atPercentile(sorted, limits.matching.sizeHighPercentile)));
  return { lo: Math.min(lo, hi), hi: Math.max(lo, hi) };
}

/** The decade of the median of ascending magnitudes (an even count: the mean of the two in the middle); null with fewer than `sizeMinValues`. */
export function medianDecadeOf(sorted: readonly Decimal[]): number | null {
  const n = sorted.length;
  if (n < limits.matching.sizeMinValues) return null;
  const mid = n % 2 === 1 ? (sorted[(n - 1) / 2] as Decimal) : (sorted[n / 2 - 1] as Decimal).plus(sorted[n / 2] as Decimal).div(2);
  return decadeOf(mid);
}

/**
 * Whether a file's column is far from what the format was learned on: the median is below 10^(lo - margin) or at least 10^(hi + 1 + margin) -
 * with whole decades that is `decade(median) < lo - margin` or `decade(median) > hi + margin`. Saved thousands to tens of thousands (lo 3, hi 4,
 * margin 1): a median of 12 is far; 99 is far; 100, 300 and 500,000 are not; 1,000,000 is.
 */
export function isFarFromRange(saved: SizeRange, medianDecade: number, margin: number = limits.matching.sizeMarginDecades): boolean {
  return medianDecade < saved.lo - margin || medianDecade > saved.hi + margin;
}

/** Reads the number columns' values once for several rules over one table: a column is parsed once per (file column, `readAs`). */
class MagnitudeCache {
  private readonly parsed = new Map<string, Decimal[]>();

  constructor(readonly table: InputTable) {}

  of(column: InputColumn, sourceIndex: number, language: 'he' | 'en'): Decimal[] {
    if (sourceIndex < 0) return [];
    const key = `${sourceIndex}|${language}|${JSON.stringify(column.readAs ?? null)}`;
    let hit = this.parsed.get(key);
    if (!hit) {
      hit = magnitudesOf(column, sourceIndex, this.table, language);
      this.parsed.set(key, hit);
    }
    return hit;
  }
}

/** The number columns of `rules` that a size means something for: used by the rules, and a number type. In declaration order. */
function sizedColumns(rules: RulesLike): InputColumn[] {
  const used = new Set(inputColumnsUsed(rules));
  return rules.input.columns.filter((c) => used.has(c.id) && isNumberColumnType(c.type));
}

/** The size range of each number column the rules use, from the example input (`table`, as the rules read it). A column with too few values has none. */
export function sizeRangesOf(rules: RulesLike, table: InputTable): Record<string, SizeRange> {
  const { src } = mapHeaders(rules.input.columns, table.headers);
  const cache = new MagnitudeCache(table);
  const out: Record<string, SizeRange> = {};
  for (const c of sizedColumns(rules)) {
    const at = src[rules.input.columns.indexOf(c)] ?? -1;
    const range = sizeRangeOfMagnitudes(cache.of(c, at, rules.output.language));
    if (range) out[c.id] = range;
  }
  return out;
}

/**
 * The rules with `input.columns[].range` set from the example input - the END of a learn (flow.ts), after the last AI round, from the example the
 * user dropped. A number column the rules use gets its range (none when the example had fewer than `sizeMinValues` non-zero values in it); any
 * other column has none. Pure; returns `rules` itself when nothing changes.
 */
export function withSizeRanges<R extends RulesLike>(rules: R, table: InputTable): R {
  const ranges = sizeRangesOf(rules, table);
  let changed = false;
  const columns = rules.input.columns.map((c): InputColumn => {
    const range = ranges[c.id];
    const same = range === undefined ? c.range === undefined : c.range !== undefined && c.range.lo === range.lo && c.range.hi === range.hi;
    if (same) return c;
    changed = true;
    const { range: _old, ...rest } = c;
    return range ? { ...rest, range } : rest;
  });
  return changed ? { ...rules, input: { ...rules.input, columns } } : rules;
}

/** A used number column of a format whose file looks far in size from what the format was learned on. Ids, headers and decades only - no value. */
export interface SizeGap {
  /** The rules' input column id. */
  id: string;
  /** The rules' declared header. */
  header: string;
  /** The range the format was learned on. */
  saved: SizeRange;
  /** The range of this file's column (same measure), what "Run anyway" widens the saved one with. */
  file: SizeRange;
  /** The decade (floor(log10)) of the file column's median: what the message says it is "mostly in". */
  median: number;
}

function gapsWith(rules: RulesLike, table: InputTable, cache: MagnitudeCache): SizeGap[] {
  const sized = sizedColumns(rules).filter((c) => c.range !== undefined);
  if (sized.length === 0) return [];
  const { src } = mapHeaders(rules.input.columns, table.headers);
  const gaps: SizeGap[] = [];
  for (const c of sized) {
    const sorted = cache.of(c, src[rules.input.columns.indexOf(c)] ?? -1, rules.output.language);
    const median = medianDecadeOf(sorted);
    const file = sizeRangeOfMagnitudes(sorted);
    if (median === null || file === null || !isFarFromRange(c.range as SizeRange, median)) continue;
    gaps.push({ id: c.id, header: c.header, saved: { ...(c.range as SizeRange) }, file, median });
  }
  return gaps;
}

/** The used number columns of `rules` whose values in `table` are far from the saved ranges (none for rules with no range). */
export function sizeGapsOf(rules: RulesLike, table: InputTable): SizeGap[] {
  return gapsWith(rules, table, new MagnitudeCache(table));
}

/** Whether the rules keep a size range for some column they use: the only rules a file needs to be read for. */
export function hasSizeRanges(rules: RulesLike): boolean {
  return sizedColumns(rules).some((c) => c.range !== undefined);
}

/**
 * The size gaps of one FILE for several conversions' rules (the Run screen's check, before the user chooses formats): per rules, in the order
 * given. The file's table is read once per distinct way of reading it (sheet, header row, stop rule: every format of one source has the same),
 * and a column is parsed once however many formats use it. Rules with no range are not looked at; a file or sheet the rules cannot be read
 * from claims nothing (the run itself says so).
 */
export function fileSizeGaps(wb: RawWorkbook, rulesList: readonly RulesLike[]): SizeGap[][] {
  const tables = new Map<string, MagnitudeCache | null>();
  return rulesList.map((rules) => {
    if (!hasSizeRanges(rules)) return [];
    const reading = JSON.stringify([rules.input.sheet, rules.input.headerRow, rules.input.stopAt ?? null]);
    let cache = tables.get(reading);
    if (cache === undefined) {
      const extracted = extractTable(wb, rules.input);
      cache = extracted.ok ? new MagnitudeCache(extracted.table) : null;
      tables.set(reading, cache);
    }
    return cache ? gapsWith(rules, cache.table, cache) : [];
  });
}
