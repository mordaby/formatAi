// Completion mode, masking on: the user's rules (`complete.fixedRules`) with every constant masked the way its COLUMN is masked - the column
// classification (`classify.ts`), the one decision every path that sends cells follows (amendment 2026-10-07, engine audit). `maskRules`
// (mask/unmaskRules.ts) used to decide by the constant's own shape: a string of digits longer than 9 and a string with no letter were
// sent real ("0501234567", "050-1234567", "4111 1111 1111 1111" came back unchanged while the samples masked them).
//
// Where a constant's column is:
//   - a row filter's value: its column; a value map's keys: the column it maps, its values: the output column that shows it;
//   - a comparison (`=`, `<`, `oneOf`, `startsWith`, `contains`, `find`, a `replaceText` search, a `split` separator, a lookup key): the
//     columns the other side reads;
//   - any other constant of a computed column (a branch's value, a `concat` part): the output column it reaches;
//   - a lookup table: its key cells by the lookup keys that read it, its other cells by the output columns its lookups reach;
//   - a check: its column.
// An expression that reads several columns has the strictest of their classes (identifier, then text); one that reads none, a label and
// anything else has no column (`unknown`), and is masked like the samples' text: digits only like an ID, anything else like text.
// A string is masked like the samples' cells of its class (`Masker.maskCell`); a category, a measure and a date are sent real. A number is
// masked only when it is a real ID number the masker has masked (`Masker.fakeNumberOf`), in an identifier's or an unknown place.
import type { ColumnClass, Expr, ExprConstValue, LearnResult, RowFilter, RulesTable, TableCellValue, Validation } from '@formatai/shared';
import { exprChildren } from '../pipeline/v1/expr';
import { mapHeaders } from '../pipeline/v1/normalize';
import type { PairAnalysis } from './analyze';
import { inputClass, outputClass } from './classify';
import { mapRuleConstants, type Masker } from './mask';

type Place = 'identifier' | 'text' | 'real' | 'unknown';
type MaskFns = Pick<Masker, 'maskText' | 'maskIdLike' | 'maskCell'> & Partial<Pick<Masker, 'fakeNumberOf'>>;

const placeOf = (c: ColumnClass): Place => (c === 'identifier' ? 'identifier' : c === 'text' ? 'text' : 'real');

const RANK: Readonly<Record<Place, number>> = { identifier: 3, text: 2, unknown: 1, real: 0 };

/** The strictest place of several (identifier, text, unknown - masked too -, real); null for none. */
function strictest(places: Iterable<Place>): Place | null {
  let best: Place | null = null;
  for (const p of places) if (best === null || RANK[p] > RANK[best]) best = p;
  return best;
}

function maskString(s: string, place: Place, m: MaskFns): string {
  if (s === '' || place === 'real') return s;
  if (place === 'identifier' || place === 'text') return String(m.maskCell(s, place) ?? s);
  return /^[0-9]+$/.test(s) ? m.maskIdLike(s) : m.maskText(s);
}

function maskNumber(n: number, place: Place, m: MaskFns): number {
  return (place === 'identifier' || place === 'unknown') && m.fakeNumberOf ? (m.fakeNumberOf(n) ?? n) : n;
}

function maskValue<V extends ExprConstValue | TableCellValue>(v: V, place: Place, m: MaskFns): V {
  if (typeof v === 'string') return maskString(v, place, m) as V;
  if (typeof v === 'number') return maskNumber(v, place, m) as V;
  return v;
}

const isNode = (e: Expr): e is Extract<Expr, { op: string }> => 'op' in e;

/** The column ids an expression reads (a window's `by` / `order` columns included). */
function idsRead(e: Expr, out: Set<string> = new Set()): Set<string> {
  if ('col' in e) out.add(e.col);
  else if (isNode(e)) {
    for (const c of exprChildren(e)) idsRead(c, out);
    if (e.op === 'window') {
      for (const id of e.by ?? []) out.add(id);
      for (const o of e.order ?? []) out.add(o.column);
    }
  }
  return out;
}

/** The places of the rules' columns: an input column by its class, a computed column by what it reads and where its value goes. */
class Places {
  private readonly input = new Map<string, Place>();
  private readonly computed: Map<string, Expr>;
  private readonly reads = new Map<string, Place | null>();
  private readonly dests = new Map<string, Place>();

  constructor(
    private readonly rules: LearnResult,
    private readonly analysis: PairAnalysis,
  ) {
    const src = mapHeaders(rules.input.columns, analysis.input.headers).src;
    rules.input.columns.forEach((c, k) => this.input.set(c.id, placeOf(inputClass(analysis, src[k] ?? -1))));
    this.computed = new Map(rules.transform.computed.map((c) => [c.id, c.expr] as const));
  }

  /** The place of the values of column `id` as read: an input column's class; a computed column's, from the columns it reads (null: none). */
  read(id: string, seen: Set<string> = new Set()): Place | null {
    const own = this.input.get(id);
    if (own !== undefined) return own;
    const expr = this.computed.get(id);
    if (expr === undefined) return 'unknown';
    const cached = this.reads.get(id);
    if (cached !== undefined) return cached;
    if (seen.has(id)) return null;
    seen.add(id);
    const place = this.expr(expr, seen);
    this.reads.set(id, place);
    return place;
  }

  /** The place of what an expression reads (null: it reads no column). */
  expr(e: Expr, seen: Set<string> = new Set()): Place | null {
    const places: Place[] = [];
    for (const id of idsRead(e)) {
      const p = this.read(id, seen);
      if (p !== null) places.push(p);
    }
    return strictest(places);
  }

  /** The place of the values column `id` gives: the output columns it reaches (directly or through the computed columns that read it). */
  dest(id: string): Place {
    const cached = this.dests.get(id);
    if (cached !== undefined) return cached;
    const reached = new Set<string>([id]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const [cid, expr] of this.computed) {
        if (reached.has(cid)) continue;
        if ([...idsRead(expr)].some((r) => reached.has(r))) {
          reached.add(cid);
          grew = true;
        }
      }
    }
    const places: Place[] = [];
    this.rules.output.columns.forEach((c, o) => {
      if (c.from !== null && reached.has(c.from)) places.push(placeOf(outputClass(this.analysis, o)));
    });
    const place = strictest(places) ?? this.read(id) ?? 'unknown';
    this.dests.set(id, place);
    return place;
  }
}

function maskExpr(e: Expr, place: Place, p: Places, m: MaskFns): Expr {
  if ('const' in e) return { const: maskValue(e.const, place, m) };
  if (!isNode(e)) return e;
  /** The place of what is compared with `x`: the columns it reads, else the surrounding place. */
  const side = (x: Expr): Place => p.expr(x) ?? place;
  const operand = (x: Expr, other: Expr): Expr => ('const' in x ? { const: maskValue(x.const, side(other), m) } : maskExpr(x, side(x), p, m));
  switch (e.op) {
    case 'eq':
    case 'ne':
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      return { ...e, args: [operand(e.args[0], e.args[1]), operand(e.args[1], e.args[0])] };
    case 'oneOf':
      return { ...e, arg: maskExpr(e.arg, side(e.arg), p, m), values: e.values.map((v) => maskValue(v, side(e.arg), m)) };
    case 'startsWith':
    case 'endsWith':
    case 'contains':
      return { ...e, arg: maskExpr(e.arg, side(e.arg), p, m), text: maskString(e.text, side(e.arg), m) };
    case 'find':
      return { ...e, arg: maskExpr(e.arg, side(e.arg), p, m), search: maskString(e.search, side(e.arg), m) };
    case 'replaceText':
      return { ...e, arg: maskExpr(e.arg, place, p, m), find: maskString(e.find, side(e.arg), m), with: maskString(e.with, place, m) };
    case 'split':
      return { ...e, arg: maskExpr(e.arg, place, p, m), separator: maskString(e.separator, side(e.arg), m) };
    case 'lookup':
      return { ...e, key: maskExpr(e.key, side(e.key), p, m) };
    case 'if':
      return { ...e, cond: maskExpr(e.cond, place, p, m), then: maskExpr(e.then, place, p, m), else: maskExpr(e.else, place, p, m) };
    case 'switch':
      return { ...e, cases: e.cases.map((c) => ({ when: maskExpr(c.when, place, p, m), then: maskExpr(c.then, place, p, m) })), else: maskExpr(e.else, place, p, m) };
    default: {
      // Every other node: its Expr children in the same place; its other fields are structural (a format, a part, digits, a window's keys).
      const node = { ...e } as Record<string, unknown>;
      if ('arg' in node && node.arg !== undefined) node.arg = maskExpr(node.arg as Expr, place, p, m);
      if ('args' in node && Array.isArray(node.args)) node.args = (node.args as Expr[]).map((a) => maskExpr(a, place, p, m));
      return node as Expr;
    }
  }
}

function maskFilter(f: RowFilter | { expr: Expr }, p: Places, m: MaskFns): RowFilter | { expr: Expr } {
  if ('expr' in f) return { ...f, expr: maskExpr(f.expr, 'unknown', p, m) };
  if (!('value' in f)) return f;
  const place = p.read(f.column) ?? 'unknown';
  return Array.isArray(f.value) ? ({ ...f, value: f.value.map((v) => maskValue(v, place, m)) } as RowFilter) : ({ ...f, value: maskValue(f.value, place, m) } as RowFilter);
}

/** Every lookup of the rules: its table, its key expression and the computed column it is in. */
function lookupsOf(rules: LearnResult): { table: string; key: Expr; computed: string }[] {
  const out: { table: string; key: Expr; computed: string }[] = [];
  const visit = (e: Expr, computed: string): void => {
    if (!isNode(e)) return;
    if (e.op === 'lookup') out.push({ table: e.table, key: e.key, computed });
    for (const c of exprChildren(e)) visit(c, computed);
  };
  for (const c of rules.transform.computed) visit(c.expr, c.id);
  return out;
}

function maskTable(t: RulesTable, lookups: { table: string; key: Expr; computed: string }[], p: Places, m: MaskFns): RulesTable {
  const mine = lookups.filter((l) => l.table === t.name);
  const keyPlace = strictest(mine.map((l) => p.expr(l.key) ?? 'unknown')) ?? 'unknown';
  const valuePlace = strictest(mine.map((l) => p.dest(l.computed))) ?? 'unknown';
  return { ...t, rows: t.rows.map((r) => r.map((v, i) => maskValue(v, i === 0 ? keyPlace : valuePlace, m))) };
}

function maskValidation(v: Validation, rules: LearnResult, analysis: PairAnalysis, p: Places, m: MaskFns): Validation {
  let place: Place = 'unknown';
  if ((v.on ?? 'input') === 'output') {
    const o = rules.output.columns.findIndex((c) => c.header === v.column);
    if (o >= 0) place = placeOf(outputClass(analysis, o));
  } else place = p.read(v.column) ?? 'unknown';
  return mapRuleConstants(v, (s) => maskString(s, place, m), (n) => maskNumber(n, place, m));
}

/**
 * The user's rules with every constant masked the way its column is masked (see the file header): `complete.fixed` of a completion call,
 * and the copy code puts back what an answer changed from (`restoreFixed`). Structural fields are untouched, as in `unmaskRules`.
 */
export function maskFixedRules(rules: LearnResult, masker: MaskFns, analysis: PairAnalysis): LearnResult {
  const p = new Places(rules, analysis);
  const unknown = <T>(x: T): T => mapRuleConstants(x, (s) => maskString(s, 'unknown', masker), (n) => maskNumber(n, 'unknown', masker));
  const t = rules.transform;
  const lookups = lookupsOf(rules);
  // Everything with no column of its own (labels, the expand's labels, unsupported and assumption notes): the `unknown` place.
  const { rowFilters, ...inputRest } = rules.input;
  const { computed, valueMaps, tables, functions, expand, ...transformRest } = t;
  const base = unknown({ ...rules, input: inputRest, transform: transformRest as LearnResult['transform'], validations: [] });
  const out: LearnResult = { ...base };
  out.input = { ...base.input, ...(rowFilters !== undefined ? { rowFilters: rowFilters.map((f) => maskFilter(f, p, masker) as RowFilter) } : {}) };
  out.transform = {
    ...base.transform,
    computed: computed.map((c) => ({ ...c, expr: maskExpr(c.expr, p.dest(c.id), p, masker) })),
    valueMaps: valueMaps.map((vm) => {
      const from = p.read(vm.column) ?? 'unknown';
      const to = p.dest(vm.column);
      return { ...vm, map: Object.fromEntries(Object.entries(vm.map).map(([k, v]) => [maskString(k, from, masker), maskString(v, to, masker)])) };
    }),
    ...(tables !== undefined ? { tables: tables.map((tb) => maskTable(tb, lookups, p, masker)) } : {}),
    ...(functions !== undefined ? { functions: functions.map((f) => ({ ...f, body: maskExpr(f.body, 'unknown', p, masker) })) } : {}),
    ...(expand !== undefined
      ? { expand: expand.mode === 'fixedFanOut' ? { ...expand, rows: expand.rows.map((r) => ({ set: Object.fromEntries(Object.entries(r.set).map(([id, e]) => [id, maskExpr(e, 'unknown', p, masker)])) })) } : unknown(expand) }
      : {}),
  };
  out.validations = rules.validations.map((v) => maskValidation(v, rules, analysis, p, masker));
  return out;
}

/**
 * Completion mode's `complete.fixed` (decision 2026-10-07, engine audit): every lookup table and value map of the user's rules goes with its
 * SHAPE only - a table's name and columns with no rows, a value map's column with no entries. Their entries are data: code filled most of them
 * from every row of the example (`fillParams`), the user may have typed others, and none of them may be sent - "nothing filled is ever sent"
 * (`flow.ts`), and a table of every key would pass the payload's row cap many times over. Which entries the AI step wrote itself is not
 * recorded, so none is sent. Code puts the user's entries back on the answer (`restoreFixed`: a fixed table or value map is the user's,
 * whole) and fills new keys from every row as always, so a lookup the AI step keeps works as before.
 */
export function withoutListEntries(rules: LearnResult): LearnResult {
  const t = rules.transform;
  return {
    ...rules,
    transform: {
      ...t,
      valueMaps: t.valueMaps.map((vm) => ({ ...vm, map: {} })),
      ...(t.tables !== undefined ? { tables: t.tables.map((tb) => ({ ...tb, rows: [] })) } : {}),
    },
  };
}
