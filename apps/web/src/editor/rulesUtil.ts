// Small, pure helpers over a rules file that every part of the editor model shares:
// which ids exist and what type they have, who references what, id generation, and the
// generic expression walker. Nothing here imports the engine.
import type {
  ColumnType,
  Computed,
  Expr,
  InputColumn,
  OutputColumnRule,
  Rules,
  SummaryAgg,
  SummaryRow,
  ValueType,
} from '@formatai/shared';
import type { EditableRules, ExampleInputColumn, SourceOption } from './types';

// ---------- comparing ----------

/** JSON with object keys sorted (and `undefined` dropped), so equal content compares equal whatever order it was built in. */
export function stable(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => {
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    }
    return v;
  }) ?? 'undefined';
}

/**
 * Structural equality that stops at any subtree both sides share by reference. Edits build new rules by spreading, so
 * what an edit did not touch (a table of 500 rows) is the same object on both sides and costs nothing to compare.
 */
export function sameContent(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => sameContent(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao).filter((k) => ao[k] !== undefined);
  const bk = Object.keys(bo).filter((k) => bo[k] !== undefined);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => Object.hasOwn(bo, k) && sameContent(ao[k], bo[k]));
}

const stableMemo = new WeakMap<object, string>();
/** `stable` for a rules subtree, remembered by identity (rules are never mutated), so unchanged parts are not re-serialized. */
export function stableOf(value: object): string {
  let s = stableMemo.get(value);
  if (s === undefined) {
    s = stable(value);
    stableMemo.set(value, s);
  }
  return s;
}

// ---------- types of ids ----------

/** SPEC 8.3: `currency` and `percent` are profile types that reach the rules language as decimal. */
export function valueTypeOf(t: ColumnType): ValueType {
  return t === 'currency' || t === 'percent' ? 'decimal' : t;
}

export const NUMERIC: ReadonlySet<ValueType> = new Set(['integer', 'decimal']);

export interface IdInfo {
  id: string;
  kind: 'input' | 'expand' | 'computed';
  /** Undefined when it can't be told (a fixed fan-out's own ids). */
  type: ValueType | undefined;
  /** For a computed id: its position in `transform.computed` (computed columns run in order). */
  computedIndex?: number;
}

/**
 * Every id a column, filter-after-expand, sort, group or validation can name, in the order the
 * engine creates them (SPEC 8.2): input columns, what expand adds (the listed columns of
 * "columns to rows" go away), then computed columns in order.
 */
export function idInfos(rules: EditableRules, opts: { computedBefore?: number } = {}): Map<string, IdInfo> {
  const map = new Map<string, IdInfo>();
  for (const c of rules.input.columns) map.set(c.id, { id: c.id, kind: 'input', type: valueTypeOf(c.type) });
  const ex = rules.transform.expand;
  if (ex) {
    if (ex.mode === 'columnsToRows') {
      for (const c of ex.columns) map.delete(c);
      map.set(ex.labelId, { id: ex.labelId, kind: 'expand', type: 'text' });
      map.set(ex.valueId, { id: ex.valueId, kind: 'expand', type: valueTypeOf(ex.valueType) });
    } else if (ex.mode === 'splitCell') {
      map.set(ex.partId, { id: ex.partId, kind: 'expand', type: 'text' });
      if (ex.indexId) map.set(ex.indexId, { id: ex.indexId, kind: 'expand', type: 'integer' });
      if (ex.countId) map.set(ex.countId, { id: ex.countId, kind: 'expand', type: 'integer' });
    } else {
      for (const row of ex.rows) {
        for (const id of Object.keys(row.set)) {
          if (!map.has(id)) map.set(id, { id, kind: 'expand', type: undefined });
        }
      }
    }
  }
  const limit = opts.computedBefore ?? rules.transform.computed.length;
  rules.transform.computed.forEach((c, i) => {
    if (i < limit) map.set(c.id, { id: c.id, kind: 'computed', type: valueTypeOf(c.type), computedIndex: i });
  });
  return map;
}

export function typeOfId(rules: EditableRules, id: string): ValueType | undefined {
  return idInfos(rules).get(id)?.type;
}

/** The type of an output column's values: the type of the id it comes from. */
export function outputColumnType(rules: EditableRules, column: OutputColumnRule, infos = idInfos(rules)): ValueType | undefined {
  return column.from === null ? undefined : infos.get(column.from)?.type;
}

// ---------- the generic expression walker ----------

function looksLikeExpr(v: unknown): v is Expr {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return 'col' in o || 'const' in o || 'param' in o || typeof o.op === 'string';
}

function visitValue(value: unknown, visit: (child: Expr) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) visitValue(item, visit);
    return;
  }
  if (looksLikeExpr(value)) {
    visit(value);
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const v of Object.values(value)) visitValue(v, visit);
  }
}

/** Every direct child expression of a node, whatever the operation (leaves have none). */
export function exprChildren(expr: Expr): Expr[] {
  if ('col' in expr || 'const' in expr || 'param' in expr) return [];
  const out: Expr[] = [];
  for (const [key, value] of Object.entries(expr)) {
    if (key === 'op') continue;
    visitValue(value, (c) => out.push(c));
  }
  return out;
}

/** Every column id an expression reads (an across-row function also reads its `by` and `order` columns). */
export function colRefs(expr: Expr, into: Set<string> = new Set()): Set<string> {
  if ('col' in expr) into.add(expr.col);
  else {
    if ('op' in expr && expr.op === 'window') {
      for (const id of expr.by ?? []) into.add(id);
      for (const key of expr.order ?? []) into.add(key.column);
    }
    for (const child of exprChildren(expr)) colRefs(child, into);
  }
  return into;
}

// ---------- who references an id ----------

/**
 * Every id that something other than the computed definitions listed in `ignoreComputed` uses:
 * output columns, other computed expressions, value maps, sort, group, validations, title parts,
 * filters, dedupe and expand inputs.
 */
export function referencedIds(
  rules: EditableRules,
  ignoreComputed: ReadonlySet<string> = new Set(),
  opts: { exprRefs?: boolean } = {},
): Set<string> {
  const used = new Set<string>();
  for (const col of rules.output.columns) if (col.from !== null) used.add(col.from);
  if (opts.exprRefs !== false) {
    for (const c of rules.transform.computed) {
      if (!ignoreComputed.has(c.id)) colRefs(c.expr, used);
    }
  }
  for (const vm of rules.transform.valueMaps) used.add(vm.column);
  for (const s of rules.transform.sort) used.add(s.column);
  const g = rules.transform.group;
  if (g) {
    used.add(g.by);
    if (g.subtotal) {
      used.add(g.subtotal.labelColumn);
      for (const id of g.subtotal.sum) used.add(id);
    }
  }
  if (rules.output.grandTotal) {
    used.add(rules.output.grandTotal.labelColumn);
    for (const id of rules.output.grandTotal.sum) used.add(id);
  }
  for (const v of rules.validations) if ((v.on ?? 'input') === 'input') used.add(v.column);
  for (const t of rules.output.titleRows) {
    if ('parts' in t) for (const p of t.parts) if ('agg' in p) used.add(p.column);
  }
  for (const f of rules.input.rowFilters ?? []) {
    if ('expr' in f) colRefs(f.expr, used);
    else used.add(f.column);
  }
  const d = rules.transform.dedupe;
  if (d && d.keys !== 'all') for (const k of d.keys) used.add(k);
  const ex = rules.transform.expand;
  if (ex) {
    if (ex.mode === 'columnsToRows') for (const c of ex.columns) used.add(c);
    else if (ex.mode === 'splitCell') used.add(ex.column);
    else for (const row of ex.rows) for (const e of Object.values(row.set)) colRefs(e, used);
  }
  return used;
}

/**
 * Removes computed columns (and their value maps) nobody uses any more, starting from
 * `candidates` and following what their expressions read. Used after an edit that stops
 * using a column the editor (or the learn) made for one output column.
 */
export function pruneComputed<T extends EditableRules>(rules: T, candidates: Iterable<string>): T {
  let current = rules;
  const queue = [...candidates];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const id = queue.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const computed = current.transform.computed.find((c) => c.id === id);
    if (!computed) continue;
    if (referencedIds(current, new Set([id])).has(id)) continue;
    const next = {
      ...current,
      transform: {
        ...current.transform,
        computed: current.transform.computed.filter((c) => c.id !== id),
        valueMaps: current.transform.valueMaps.filter((vm) => vm.column !== id),
      },
    } as T;
    current = next;
    for (const ref of colRefs(computed.expr)) queue.push(ref);
  }
  return current;
}

/** Removes value maps on `ids` when nothing else reads them any more. */
export function pruneValueMaps<T extends EditableRules>(rules: T, ids: Iterable<string>): T {
  const check = new Set(ids);
  if (check.size === 0) return rules;
  // What still reads an id once the value maps themselves (which name their column) are set aside. A computed
  // column reads its inputs BEFORE the value maps run (SPEC 8.2 steps 6-7), so it does not count as a reader.
  const used = referencedIds({ ...rules, transform: { ...rules.transform, valueMaps: [] } } as T, new Set(), { exprRefs: false });
  const drop = new Set([...check].filter((id) => !used.has(id)));
  if (drop.size === 0) return rules;
  return {
    ...rules,
    transform: { ...rules.transform, valueMaps: rules.transform.valueMaps.filter((vm) => !drop.has(vm.column)) },
  } as T;
}

// ---------- ids ----------

/** All ids in use anywhere in the pipeline, so a generated one can't collide. */
export function allIds(rules: EditableRules): Set<string> {
  const ids = new Set<string>();
  for (const c of rules.input.columns) ids.add(c.id);
  for (const c of rules.transform.computed) ids.add(c.id);
  const ex = rules.transform.expand;
  if (ex) {
    if (ex.mode === 'columnsToRows') {
      ids.add(ex.labelId);
      ids.add(ex.valueId);
    } else if (ex.mode === 'splitCell') {
      ids.add(ex.partId);
      if (ex.indexId) ids.add(ex.indexId);
      if (ex.countId) ids.add(ex.countId);
    } else {
      for (const row of ex.rows) for (const id of Object.keys(row.set)) ids.add(id);
    }
  }
  return ids;
}

/** `base1`, `base2`, ...: the first one not in use. */
export function freshId(rules: EditableRules, base: string): string {
  const used = allIds(rules);
  for (let n = 1; ; n++) {
    const id = `${base}${n}`;
    if (!used.has(id)) return id;
  }
}

// ---------- computed columns of one output column ----------

/** The computed id behind an output column, when that output column is the only thing using it. */
export function ownedComputedId(rules: EditableRules, index: number): string | undefined {
  const col = rules.output.columns[index];
  if (!col || col.from === null) return undefined;
  const id = col.from;
  if (!rules.transform.computed.some((c) => c.id === id)) return undefined;
  const others: EditableRules = {
    ...rules,
    output: { ...rules.output, columns: rules.output.columns.filter((_, i) => i !== index) },
  } as EditableRules;
  return referencedIds(others, new Set([id])).has(id) ? undefined : id;
}

export function withComputed<T extends EditableRules>(rules: T, computed: Computed[]): T {
  return { ...rules, transform: { ...rules.transform, computed } } as T;
}

export function withColumns<T extends EditableRules>(rules: T, columns: OutputColumnRule[]): T {
  return { ...rules, output: { ...rules.output, columns } } as T;
}

// ---------- input columns of the example that no rule declares yet ----------

/** A header compared the way a person reads it: case, spacing and surrounding blanks do not matter. */
export function normalizeHeader(header: string): string {
  return header.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** `unitPrice` for "Unit price"; empty when the header has no latin letters or digits (a Hebrew header). */
function slug(header: string): string {
  const words = header
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return '';
  return words.map((w, i) => (i === 0 ? w.toLowerCase() : w[0]!.toUpperCase() + w.slice(1).toLowerCase())).join('');
}

/** The declaration an example input column gets when a rule first uses it (the way the local learn declares one). */
export function inputColumnFor(id: string, c: ExampleInputColumn): InputColumn {
  const type: ColumnType = c.serialDates ? 'date' : c.type === 'empty' ? 'text' : c.type;
  const col: InputColumn = { id, header: c.header, type };
  if (type === 'idLike' && c.leadingZerosLost) {
    const width = c.israeliId ? 9 : c.maxLength;
    if (width !== undefined && width > 0) col.padLeft = width;
  }
  if (type === 'date') {
    const formats: string[] = [];
    if (c.dateFormat !== undefined && c.dateFormat !== 'excel') formats.push(c.dateFormat);
    if (c.serialDates) formats.push('excelSerial');
    if (formats.length > 0) col.inputFormats = formats;
  }
  return col;
}

export interface AvailableInput {
  /** The id it has once declared (unique among every id in the rules and among the other available columns). */
  id: string;
  /** What to add to `rules.input.columns`. */
  column: InputColumn;
}

/**
 * The example input's columns that the rules do not declare yet, in file order, each with the id it would get. A column
 * is "declared" when an input column has its header (or an alias of it). The ids are made one after the other, so they
 * are distinct, and they come out the same whenever the rules and the list are the same.
 */
export function availableInputs(rules: EditableRules, exampleInput: readonly ExampleInputColumn[] | undefined): AvailableInput[] {
  if (!exampleInput || exampleInput.length === 0) return [];
  const known = new Set<string>();
  for (const c of rules.input.columns) {
    known.add(normalizeHeader(c.header));
    for (const a of c.aliases ?? []) known.add(normalizeHeader(a));
  }
  const used = allIds(rules);
  const out: AvailableInput[] = [];
  exampleInput.forEach((c, i) => {
    const key = normalizeHeader(c.header);
    if (key === '' || known.has(key)) return;
    known.add(key);
    let base = slug(c.header);
    if (base === '' || /^[0-9]/.test(base)) base = `c${i + 1}`;
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}${n}`;
    used.add(id);
    out.push({ id, column: inputColumnFor(id, c) });
  });
  return out;
}

/** The rules with these input columns declared (after the ones already there). */
export function withInputColumns<T extends EditableRules>(rules: T, columns: readonly InputColumn[]): T {
  if (columns.length === 0) return rules;
  return { ...rules, input: { ...rules.input, columns: [...rules.input.columns, ...columns] } } as T;
}

// ---------- source options for the dropdowns ----------

/**
 * What a "source column" dropdown offers: the input columns and what expand adds, plus the computed
 * columns that an output column shows (labelled by that output header) and that come before
 * `forColumn`'s own computed column (computed columns run in order). Then every column of the example input
 * (`exampleInput`) that no rule declares yet, as kind `available`: choosing one declares it.
 */
export function sourceOptions(rules: EditableRules, opts: { forColumn?: number; exampleInput?: readonly ExampleInputColumn[] | undefined } = {}): SourceOption[] {
  const own = opts.forColumn === undefined ? undefined : ownedComputedId(rules, opts.forColumn);
  const limit = own === undefined ? undefined : rules.transform.computed.findIndex((c) => c.id === own);
  const infos = idInfos(rules, limit !== undefined && limit >= 0 ? { computedBefore: limit } : {});
  const headerOfComputed = new Map<string, string>();
  rules.output.columns.forEach((c, i) => {
    if (c.from !== null && i !== opts.forColumn && !headerOfComputed.has(c.from)) headerOfComputed.set(c.from, c.header);
  });
  const options: SourceOption[] = [];
  for (const info of infos.values()) {
    if (info.kind === 'computed') {
      const header = headerOfComputed.get(info.id);
      if (header === undefined) continue;
      options.push({ id: info.id, label: header, type: info.type, kind: 'computed' });
    } else if (info.kind === 'input') {
      const col = rules.input.columns.find((c) => c.id === info.id);
      options.push({ id: info.id, label: col?.header || info.id, type: info.type, kind: 'input' });
    } else {
      options.push({ id: info.id, label: info.id, type: info.type, kind: 'expand' });
    }
  }
  for (const a of availableInputs(rules, opts.exampleInput)) {
    options.push({ id: a.id, label: a.column.header, type: valueTypeOf(a.column.type), kind: 'available' });
  }
  return options;
}

// ---------- summary rows (the effective list; migrates the deprecated fields) ----------

type DeprecatedTotal = { labelColumn: string; label: string; sum: string[] };

/** Mirror of the engine's `translateDeprecatedTotal` (packages/engine/src/rules/summaryRows.ts). */
function translateDeprecatedTotal(spec: DeprecatedTotal, columns: readonly OutputColumnRule[], summaryMode: boolean): SummaryRow {
  const sumIds = new Set(spec.sum);
  const cells: Record<string, SummaryAgg> = {};
  for (const c of columns) {
    if (c.from === null || !sumIds.has(c.from)) continue;
    if (!summaryMode) {
      cells[c.header] = 'sum';
      continue;
    }
    const agg = c.agg ?? 'first';
    if (agg === 'sum' || agg === 'count') cells[c.header] = agg;
  }
  const row: SummaryRow = { cells, label: spec.label };
  const labelCol = columns.find((c) => c.from === spec.labelColumn);
  if (labelCol) row.labelColumn = labelCol.header;
  return row;
}

/** The summary rows after all data rows, as the engine will run them. */
export function effectiveEndSummaryRows(rules: EditableRules): SummaryRow[] {
  const out = rules.output;
  if (out.summaryRows && out.summaryRows.length > 0) return out.summaryRows;
  if (!out.grandTotal) return [];
  const g = rules.transform.group;
  return [translateDeprecatedTotal(out.grandTotal, out.columns, g !== undefined && g.showDetailRows === false)];
}

/** The summary rows after each group, as the engine will run them. */
export function effectiveGroupSummaryRows(rules: EditableRules): SummaryRow[] {
  const g = rules.transform.group;
  if (!g) return [];
  if (g.summaryRows && g.summaryRows.length > 0) return g.summaryRows;
  if (!g.showDetailRows || !g.subtotal) return [];
  return [translateDeprecatedTotal(g.subtotal, rules.output.columns, false)];
}

export function isStored(rules: EditableRules): rules is Rules {
  return 'meta' in rules;
}

