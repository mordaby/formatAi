// Taking a column's rule out, and a list copied from the example (owner amendment, 2026-10-06; SPEC "Amendment (owner, 2026-10-06): a list
// copied from the example is a question").
//
// `withColumnsTakenOut` is the one way code turns a column into "needs your input" (8.10): the overfitting guards' honest fallback (engine
// `withOverfitFallback`, reason `overfit`) and the answer "a one-time edit" to a copied-list question. The output column reads nothing
// (`from: null`, its values left empty), it is reported as unsupported with the reason given, and the computed columns and lookup tables
// nothing reads any more go with it.
//
// A copied list: a column whose value comes from a lookup table or a value map keyed on a column that is different on every row of the
// example. Code fills such a list from every row (`fillParams`), and a copied list always reproduces the example it was copied from, so
// the check on every row cannot tell a real mapping (recurring customers) from a copy (order numbers). The engine asks (`copiedLists`,
// `learn/oneTimers.ts`); "a rule" keeps it as it is, "a one-time edit" is `withoutCopiedList`. Here, in the shared package, because both
// sides apply it: the browser's main thread (which never loads the engine) and the eval.
//
// Pure: no I/O, no engine.
import type { UnsupportedReasonCode } from '../codes';
import type { Expr, LearnResult, Rules } from './schema';

type AnyRules = LearnResult | Rules;

/** The list a copied-list question is about: a lookup table that the column's computed column looks up, or the value map on the column it reads. */
export type CopiedListRule =
  | { kind: 'lookup'; computed: string; table: string }
  | { kind: 'valueMap'; column: string };

/**
 * The reason a column whose list was a one-time edit is reported with. DECISION: `overfit`, code's own reason for a column whose only rule
 * copies rows of the example ("needs your input", 8.10) - the user has just said so. Never `externalData`: that is the AI step's word for
 * values that come from elsewhere, and code does not know where they come from.
 */
export const COPIED_LIST_REASON: UnsupportedReasonCode = 'overfit';

/** The column ids an expression (or any part of the rules) reads: every `col`, and a window's `by` / `order` columns. */
function idsRead(e: unknown, out: Set<string>): Set<string> {
  if (Array.isArray(e)) {
    for (const x of e) idsRead(x, out);
    return out;
  }
  if (typeof e !== 'object' || e === null) return out;
  const o = e as Record<string, unknown>;
  if (typeof o.col === 'string') out.add(o.col);
  if (o.op === 'window') {
    for (const id of (o.by as string[] | undefined) ?? []) out.add(id);
    for (const x of (o.order as { column: string }[] | undefined) ?? []) out.add(x.column);
  }
  for (const v of Object.values(o)) if (typeof v === 'object' && v !== null) idsRead(v, out);
  return out;
}

/**
 * Whether the rules mention `id` outside the computed column `id` itself (its readers, filters, sort, group, validations, output ...).
 * DECISION: the lookup tables are left out - they hold data and are named by `lookup`, never an id (a table column called like the computed
 * column that looks it up, `lookup("managers", account, "manager")` in `manager`, is no reader of it).
 */
function referencedElsewhere(rules: AnyRules, id: string): boolean {
  const { tables: _tables, ...transform } = rules.transform;
  const rest = { ...rules, transform: { ...transform, computed: rules.transform.computed.filter((c) => c.id !== id) } };
  return JSON.stringify(rest).includes(JSON.stringify(id));
}

/**
 * The output columns `headers` reported as unsupported with `reasonCode` (`from: null`: "needs your input", like an `externalData` column the
 * AI step reports itself; a column already listed keeps its entry), and the computed columns nothing reads any more taken out - starting from
 * `freed` (the computed columns those columns' rules were in), one at a time, since a helper may free another - and then the lookup tables
 * nothing looks up any more. Everything else is kept as it is.
 */
export function withColumnsTakenOut<R extends AnyRules>(rules: R, headers: ReadonlySet<string>, reasonCode: UnsupportedReasonCode, freed: Iterable<string>): R {
  const columns = rules.output.columns.map((c) => (headers.has(c.header) ? { ...c, from: null } : c));
  const unsupported = [
    ...rules.unsupported,
    ...[...headers].filter((h) => !rules.unsupported.some((u) => u.outputColumn === h)).map((outputColumn) => ({ outputColumn, reasonCode })),
  ];
  let next = { ...rules, output: { ...rules.output, columns }, unsupported } as R;
  const candidates = new Set(freed);
  for (let changed = true; changed; ) {
    changed = false;
    for (const c of next.transform.computed) {
      if (!candidates.has(c.id) || referencedElsewhere(next, c.id)) continue;
      for (const id of idsRead(c.expr, new Set())) candidates.add(id);
      next = { ...next, transform: { ...next.transform, computed: next.transform.computed.filter((x) => x.id !== c.id) } } as R;
      changed = true;
      break;
    }
  }
  // (A table of the example's values holds this file's rows: one nothing looks up is not kept.)
  const tables = next.transform.tables;
  if (tables && tables.length > 0) {
    const text = JSON.stringify({ ...next, transform: { ...next.transform, tables: [] } });
    const used = tables.filter((t) => text.includes(`"table":${JSON.stringify(t.name)}`));
    if (used.length < tables.length) next = { ...next, transform: { ...next.transform, tables: used } } as R;
  }
  return next;
}

/** Whether `e` looks a value up in table `table`. */
function looksUp(e: unknown, table: string): boolean {
  if (Array.isArray(e)) return e.some((x) => looksUp(x, table));
  if (typeof e !== 'object' || e === null) return false;
  const o = e as Record<string, unknown>;
  if (o.op === 'lookup' && o.table === table) return true;
  return Object.values(o).some((v) => typeof v === 'object' && v !== null && looksUp(v, table));
}

/**
 * Whether the column still takes its value from the list, as when the question was asked: it reads the computed column that looks the table
 * up (and the table is there), or the column the value map is on (and the map is there). False once the column was changed or left empty.
 */
export function hasCopiedList(rules: AnyRules, header: string, list: CopiedListRule): boolean {
  const column = rules.output.columns.find((c) => c.header === header);
  if (!column || column.from === null) return false;
  if (list.kind === 'valueMap') return column.from === list.column && rules.transform.valueMaps.some((m) => m.column === list.column);
  const computed = rules.transform.computed.find((c) => c.id === list.computed);
  return column.from === list.computed && computed !== undefined && looksUp(computed.expr as Expr, list.table) && (rules.transform.tables ?? []).some((t) => t.name === list.table);
}

/**
 * The answer "a one-time edit" to a copied-list question: the column's rule goes - it is reported as unsupported (`COPIED_LIST_REASON`,
 * "needs your input") and left empty - and the table nothing looks up any more goes with it; a value map goes when no output column reads
 * its column any more and no check reads it. Null when the column does not take its value from the list any more (`hasCopiedList`).
 */
export function withoutCopiedList<R extends AnyRules>(rules: R, header: string, list: CopiedListRule): R | null {
  if (!hasCopiedList(rules, header, list)) return null;
  const next = withColumnsTakenOut(rules, new Set([header]), COPIED_LIST_REASON, list.kind === 'lookup' ? [list.computed] : []);
  if (list.kind === 'lookup') return next;
  const stillRead = next.output.columns.some((c) => c.from === list.column) || next.validations.some((v) => v.column === list.column);
  return stillRead ? next : ({ ...next, transform: { ...next.transform, valueMaps: next.transform.valueMaps.filter((m) => m.column !== list.column) } } as R);
}
