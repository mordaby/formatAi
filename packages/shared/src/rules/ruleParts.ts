// One part of a rule (SPEC 8.11 "A one-time edit or a rule?", 21 v12 item 20; owner decision 2026-10-05): a branch of an `if` / `switch`,
// one value of a value list in a condition, one entry of a lookup table, one entry of a value map. The engine counts how many rows of the
// example each part explains (`learn/oneTimers.ts`); when a part explains exactly one row, singled out by something unique to it (its ID, an
// exact amount, its position), the Result screen asks whether that row was a one-time change or a rule we missed - and "one-time" takes the
// part out (`withoutRulePart`), so the column's remaining rule applies to every row.
//
// A part is said by its CONTENT, never by a path: the condition and the value of a branch, the expression and the value of a list. So it is
// found again in rules that changed since the learn (another part taken out, an edit elsewhere), and a part the user has changed is simply
// not there any more (`hasRulePart`). Here, in the shared package, because both sides apply it: the engine (the learn flow, the eval) and the
// browser's main thread (which never loads the engine).
//
// Pure: no I/O, no engine.
import type { Expr, ExprConstValue, ExprNode, LearnResult, Rules, TableCellValue } from './schema';

export type RulePart =
  /** A branch of computed column `computed`: an `if` whose condition and value are `when` / `then`, or a `switch` case with them. */
  | { kind: 'branch'; computed: string; when: Expr; then: Expr }
  /** One value of a value list in a condition of `computed`: `oneOf(arg, ..., value, ...)` or `or(arg = ..., arg = value, ...)`. */
  | { kind: 'listValue'; computed: string; arg: Expr; value: ExprConstValue }
  /** The row of lookup table `table` whose key (its first cell) is `key`. */
  | { kind: 'lookupEntry'; table: string; key: TableCellValue }
  /** The entry `from` of the value map on `column`. */
  | { kind: 'valueMapEntry'; column: string; from: string };

type AnyRules = LearnResult | Rules;

/** A value as JSON with every object's keys in order, so two equal expressions compare equal whatever order their keys were written in. */
export function canonicalJson(v: unknown): string {
  return (
    JSON.stringify(v, (_k, x: unknown) =>
      typeof x === 'object' && x !== null && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x,
    ) ?? 'undefined'
  );
}

const same = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);

const isNode = (e: unknown): e is ExprNode => typeof e === 'object' && e !== null && 'op' in e;

/** `eq(arg, value)` or `eq(value, arg)`. */
function isEqTo(e: Expr, arg: Expr, value: ExprConstValue): boolean {
  if (!isNode(e) || e.op !== 'eq') return false;
  const [a, b] = e.args;
  return (same(a, arg) && 'const' in b && same(b.const, value)) || (same(b, arg) && 'const' in a && same(a.const, value));
}

/**
 * `e` with the first node `edit` changes (pre-order: a node before its children, children in order) replaced by what it returns; `undefined`
 * from `edit` means "not this node". Returns `null` when no node was changed. Every node not on the way to the change is shared.
 */
function editFirst(e: Expr, edit: (n: ExprNode) => Expr | undefined): Expr | null {
  if (!isNode(e)) return null;
  const here = edit(e);
  if (here !== undefined) return here;
  for (const [k, v] of Object.entries(e)) {
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        const item: unknown = v[i];
        if (k === 'cases' && typeof item === 'object' && item !== null && 'when' in item && 'then' in item) {
          const cs = item as { when: Expr; then: Expr };
          const w = editFirst(cs.when, edit);
          const t = w === null ? editFirst(cs.then, edit) : null;
          if (w !== null || t !== null) {
            const arr = [...v];
            arr[i] = w !== null ? { when: w, then: cs.then } : { when: cs.when, then: t! };
            return { ...e, [k]: arr } as Expr;
          }
        } else if (isNode(item) || (typeof item === 'object' && item !== null && ('col' in item || 'const' in item))) {
          const next = editFirst(item as Expr, edit);
          if (next !== null) {
            const arr = [...v];
            arr[i] = next;
            return { ...e, [k]: arr } as Expr;
          }
        }
      }
    } else if (isNode(v)) {
      const next = editFirst(v, edit);
      if (next !== null) return { ...e, [k]: next } as Expr;
    }
  }
  return null;
}

/** The expression with the part taken out (a branch: the rest of the chain; a list value: the list without it), or null when it is not there. */
function exprWithout(e: Expr, part: Extract<RulePart, { kind: 'branch' | 'listValue' }>): Expr | null {
  if (part.kind === 'branch') {
    return editFirst(e, (n) => {
      if (n.op === 'if' && same(n.cond, part.when) && same(n.then, part.then)) return n.else;
      if (n.op === 'switch') {
        const i = n.cases.findIndex((c) => same(c.when, part.when) && same(c.then, part.then));
        if (i < 0) return undefined;
        const cases = n.cases.filter((_, j) => j !== i);
        return cases.length === 0 ? n.else : { ...n, cases };
      }
      return undefined;
    });
  }
  return editFirst(e, (n) => {
    if (n.op === 'oneOf' && same(n.arg, part.arg) && n.values.some((v) => same(v, part.value))) {
      const values = n.values.filter((v) => !same(v, part.value));
      // (A list of one value is no list: the engine never asks about one. Emptied, it would hold for no row: left as it is.)
      return values.length === 0 ? undefined : { ...n, values };
    }
    if (n.op === 'or' && n.args.some((a) => isEqTo(a, part.arg, part.value))) {
      const args = n.args.filter((a) => !isEqTo(a, part.arg, part.value));
      if (args.length === 0) return undefined;
      return args.length === 1 ? args[0]! : { ...n, args };
    }
    return undefined;
  });
}

/** Whether the part is in the rules, as it was when the engine counted it. */
export function hasRulePart(rules: AnyRules, part: RulePart): boolean {
  return withoutRulePart(rules, part) !== null;
}

/**
 * The rules with the part taken out, so the rest of the column's rule applies to the row it explained: a branch is replaced by the rest of
 * its chain (an `if` by its else, a `switch` loses the case, and a `switch` left without cases is its else), a list loses the value (an
 * `or` of one comparison is that comparison), a lookup table loses the row with that key, a value map loses the entry. Nothing else
 * changes. Null when the part is not there (the user changed it, or it was taken out already).
 */
export function withoutRulePart<R extends AnyRules>(rules: R, part: RulePart): R | null {
  switch (part.kind) {
    case 'branch':
    case 'listValue': {
      const at = rules.transform.computed.findIndex((c) => c.id === part.computed);
      const c = rules.transform.computed[at];
      if (!c) return null;
      const expr = exprWithout(c.expr, part);
      if (expr === null) return null;
      return { ...rules, transform: { ...rules.transform, computed: rules.transform.computed.map((x, i) => (i === at ? { ...x, expr } : x)) } };
    }
    case 'lookupEntry': {
      const tables = rules.transform.tables ?? [];
      const at = tables.findIndex((t) => t.name === part.table);
      const table = tables[at];
      if (!table || !table.rows.some((r) => same(r[0] ?? null, part.key))) return null;
      const next = { ...table, rows: table.rows.filter((r) => !same(r[0] ?? null, part.key)) };
      return { ...rules, transform: { ...rules.transform, tables: tables.map((t, i) => (i === at ? next : t)) } };
    }
    case 'valueMapEntry': {
      const at = rules.transform.valueMaps.findIndex((m) => m.column === part.column && Object.prototype.hasOwnProperty.call(m.map, part.from));
      const vm = rules.transform.valueMaps[at];
      if (!vm) return null;
      const { [part.from]: _gone, ...map } = vm.map;
      return { ...rules, transform: { ...rules.transform, valueMaps: rules.transform.valueMaps.map((m, i) => (i === at ? { ...m, map } : m)) } };
    }
  }
}
