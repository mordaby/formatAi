// The size range of a number column (SPEC 5 C, 8.15, owner decision 2026-10-08): pure helpers on `input.columns[].range`, shared by the engine
// (the end of a learn writes it, a run checks a file against it), the API (a new version of a conversion keeps the wider of the two; "Run anyway"
// widens it) and the web app. Two small integers per column - decade exponents - and never a value.
import { z } from 'zod';
import { type ColumnType, type InputColumn, type LearnResult, type Rules, type SizeRange, SizeRangeSchema } from './rules/schema';

/** Number types: the ones a size means something for (text, dates, ids and yes/no values have none). The engine's `typeCat(...) === 'number'`. */
export function isNumberColumnType(type: ColumnType): boolean {
  return type === 'integer' || type === 'decimal' || type === 'currency' || type === 'percent';
}

/** The range that covers both. */
export function unionRange(a: SizeRange, b: SizeRange): SizeRange {
  return { lo: Math.min(a.lo, b.lo), hi: Math.max(a.hi, b.hi) };
}

/** Whether `inner` is inside `outer` (so a union with it changes nothing). */
export function rangeCovers(outer: SizeRange, inner: SizeRange): boolean {
  return outer.lo <= inner.lo && outer.hi >= inner.hi;
}

type RulesLike = Rules | LearnResult;

/**
 * `next` for a NEW VERSION of a conversion whose current version is `previous` (an editor save, Save's "Update your format X?", a restored
 * version): each number column keeps the UNION (lowest `lo`, highest `hi`) of the previous version's range and its own, found by column id.
 *  - Both have one: the union - an update learned on a quiet month never narrows what the format was learned on.
 *  - Only the previous has one (the new example had too few values, or the save came from a client that dropped it): the previous is kept.
 *    DECISION: nothing in the product clears a range, so a missing one on a save is never an intent to forget it.
 *  - A column that is not a number (any more) has none.
 * Returns `next` itself when nothing changes. Never touches anything but `range`.
 */
export function keepWiderRanges<R extends RulesLike>(previous: RulesLike | null | undefined, next: R): R {
  const before = new Map((previous?.input.columns ?? []).map((c) => [c.id, c] as const));
  let changed = false;
  const columns = next.input.columns.map((c): InputColumn => {
    if (!isNumberColumnType(c.type)) {
      if (c.range === undefined) return c;
      changed = true;
      const { range: _range, ...rest } = c;
      return rest;
    }
    const was = before.get(c.id);
    const prior = was && isNumberColumnType(was.type) ? was.range : undefined;
    if (prior === undefined) return c;
    const range = c.range === undefined ? prior : unionRange(prior, c.range);
    if (c.range !== undefined && c.range.lo === range.lo && c.range.hi === range.hi) return c;
    changed = true;
    return { ...c, range };
  });
  return changed ? { ...next, input: { ...next.input, columns } } : next;
}

/** `rules` without any size range (what is never sent to the AI step). */
export function withoutRanges<R extends RulesLike>(rules: R): R {
  if (!rules.input.columns.some((c) => c.range !== undefined)) return rules;
  return { ...rules, input: { ...rules.input, columns: rules.input.columns.map(({ range: _range, ...c }) => c) } };
}

export interface Widened<R extends RulesLike> {
  rules: R;
  /** The ids of the columns whose range grew, in the rules' order. */
  widened: string[];
}

/**
 * "Run anyway" widens (SPEC 8.15): for each of `add`'s column ids that is a number column of `rules` WITH a range already, the range becomes the
 * union of the two. It can only grow: a column with no range gets none (a column nothing was learned about is never checked, so it is never
 * asked about), an id the rules do not have is ignored, a column that is not a number is ignored, and a range inside the saved one changes
 * nothing. Bounds are the caller's to validate (`SizeRangeSchema`).
 */
export function widenRanges<R extends RulesLike>(rules: R, add: Readonly<Record<string, SizeRange>>): Widened<R> {
  const widened: string[] = [];
  const columns = rules.input.columns.map((c): InputColumn => {
    const extra = Object.prototype.hasOwnProperty.call(add, c.id) ? add[c.id] : undefined;
    if (extra === undefined || c.range === undefined || !isNumberColumnType(c.type) || rangeCovers(c.range, extra)) return c;
    widened.push(c.id);
    return { ...c, range: unionRange(c.range, extra) };
  });
  return widened.length === 0 ? { rules, widened } : { rules: { ...rules, input: { ...rules.input, columns } }, widened };
}

/** POST /api/conversions/:id/widen-ranges body: column id -> the range of this file's column (bounded integers; an unknown id is ignored later). */
export const WidenRangesBodySchema = z.strictObject({ columns: z.record(z.string().min(1).max(200), SizeRangeSchema) });
