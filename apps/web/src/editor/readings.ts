// Answering the ambiguity question (SPEC 8.11, 21 v12 item 11): an output column whose example fits several rules (a constant the input
// could write too) comes from the engine as `AmbiguousColumn` - its readings, each a ready-to-apply rule FRAGMENT. This module applies a
// reading to the rules (merging the fragment: its input columns are matched to the rules' own by header, its computed columns get fresh
// ids), and keeps the question's marker: the check that goes with an UNANSWERED question (it flags a run-time row where the readings
// differ). The marker IS the state: present = the question is open, and the user can delete the check in the rules editor to close it.
// Pure; no engine code (types only: the main thread never loads the engine, see boundaries.test.ts).
import type { AmbiguousColumn, RuleFragment } from '@formatai/engine';
import type { Computed, Expr, InputColumn, Validation } from '@formatai/shared';
import { allIds, normalizeHeader, pruneComputed } from './rulesUtil';
import type { EditableRules } from './types';

// ---------- the marker ----------

function sortedJson(v: object): string {
  return JSON.stringify(Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));
}

/** Whether a validation is the check of this question (the mirror of the engine's `isReadingCheck`). */
export function isReadingCheck(v: Validation, column: Pick<AmbiguousColumn, 'check'>): boolean {
  return column.check !== null && sortedJson(v) === sortedJson(column.check);
}

/** The question is open: its column has a rule and the check that marks it as unanswered is in the rules. */
export function questionOpen(rules: EditableRules, column: AmbiguousColumn): boolean {
  return rules.validations.some((v) => isReadingCheck(v, column)) && rules.output.columns.some((c) => c.header === column.header && c.from !== null);
}

// ---------- merging a fragment ----------

/** Input columns that read the same: text and an id are both text; the numbers are one kind. */
function kindOf(type: InputColumn['type']): string {
  return type === 'idLike' ? 'text' : type === 'currency' || type === 'percent' || type === 'integer' || type === 'decimal' ? 'number' : type;
}

function uniqueId(used: Set<string>, base: string): string {
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}${n}`;
  used.add(id);
  return id;
}

/** The expression with every column id it reads renamed (`rename`); an id not in the map stays. */
function renameCols(expr: Expr, rename: ReadonlyMap<string, string>): Expr {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v !== 'object' || v === null) return v;
    const o = v as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(o).map(([k, x]) => {
        if (k === 'col' && typeof x === 'string') return [k, rename.get(x) ?? x];
        // (an across-row function names its group columns and its order columns)
        if (k === 'by' && Array.isArray(x)) return [k, x.map((id) => (typeof id === 'string' ? (rename.get(id) ?? id) : id))];
        if (k === 'column' && typeof x === 'string' && 'dir' in o) return [k, rename.get(x) ?? x];
        return [k, walk(x)];
      }),
    );
  };
  return walk(expr) as Expr;
}

function mergeFragment<R extends EditableRules>(rules: R, f: RuleFragment): { rules: R; from: string } | null {
  const used = allIds(rules);
  const rename = new Map<string, string>();
  const inputs = [...rules.input.columns];
  for (const c of f.inputColumns) {
    const key = normalizeHeader(c.header);
    const have = inputs.find((x) => normalizeHeader(x.header) === key || (x.aliases ?? []).some((a) => normalizeHeader(a) === key));
    if (have) {
      // The rules read this column another way (a text where the fragment reads a date): a reading made for the other would not mean the same.
      if (kindOf(have.type) !== kindOf(c.type)) return null;
      rename.set(c.id, have.id);
    } else {
      const id = uniqueId(used, c.id);
      rename.set(c.id, id);
      inputs.push({ ...c, id });
    }
  }
  const computed: Computed[] = [...rules.transform.computed];
  for (const c of f.computed) {
    const id = uniqueId(used, c.id);
    rename.set(c.id, id);
    computed.push({ ...c, id, expr: renameCols(c.expr, rename) });
  }
  const valueMaps = [...rules.transform.valueMaps, ...f.valueMaps.map((vm) => ({ ...vm, column: rename.get(vm.column) ?? vm.column }))];
  const merged = {
    ...rules,
    input: { ...rules.input, columns: inputs },
    transform: { ...rules.transform, computed, valueMaps },
  } as R;
  return { rules: merged, from: rename.get(f.from) ?? f.from };
}

// ---------- comparing what a column does ----------

/** What a column's rule does, with ids resolved to the headers of the input columns (so two ways of building the same rule compare equal). */
function ruleKey(rules: EditableRules, header: string): string | undefined {
  const col = rules.output.columns.find((c) => c.header === header);
  if (!col) return undefined;
  if (col.from === null) return 'none';
  const inputs = new Map(rules.input.columns.map((c) => [c.id, c] as const));
  const computed = new Map(rules.transform.computed.map((c) => [c.id, c] as const));
  const maps = new Map(rules.transform.valueMaps.map((v) => [v.column, v] as const));
  const resolve = (id: string, seen: ReadonlySet<string>): unknown => {
    if (seen.has(id)) return { cycle: id };
    const next = new Set(seen).add(id);
    const input = inputs.get(id);
    const c = computed.get(id);
    const body = input
      ? { input: input.header, type: input.type, padLeft: input.padLeft, inputFormats: input.inputFormats }
      : c
        ? { type: c.type, expr: expand(c.expr, next) }
        : { unknown: id };
    return { ...body, map: maps.get(id) };
  };
  const expand = (e: Expr, seen: ReadonlySet<string>): unknown => {
    const walk = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(walk);
      if (typeof v !== 'object' || v === null) return v;
      const o = v as Record<string, unknown>;
      if (typeof o.col === 'string' && Object.keys(o).length === 1) return { col: resolve(o.col, seen) };
      return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, walk(x)]));
    };
    return walk(e);
  };
  return sortedDeep(resolve(col.from, new Set()));
}

function sortedDeep(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) =>
    typeof x === 'object' && x !== null && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x,
  ) ?? 'undefined';
}

// ---------- applying a reading ----------

/**
 * The rules with the column read the way `column.readings[index]` says. `check`: the question's marker goes in (the question stays open: the
 * default state, what "Not sure" keeps); otherwise it comes out (the question is answered). Null when the reading cannot be applied here: the
 * column is not in the rules, or the rules read an input column of the fragment another way (a different type).
 * The old rule's computed column goes when nothing else reads it. A column the AI step reported as unsupported has its note taken out
 * (it has a rule now).
 */
export function applyReading<R extends EditableRules>(rules: R, column: AmbiguousColumn, index: number, check: boolean): R | null {
  const reading = column.readings[index];
  const at = rules.output.columns.findIndex((c) => c.header === column.header);
  if (!reading || at < 0) return null;

  const validations = rules.validations.filter((v) => !isReadingCheck(v, column));
  const withMarker = check && column.check !== null ? [...validations, column.check] : validations;
  const unsupported = rules.unsupported.filter((u) => u.outputColumn !== column.header);

  // The column already reads this way (the free engine built the data reading itself): only the marker changes.
  const merged = mergeFragment(rules, reading.fragment);
  if (merged === null) return null;
  const old = rules.output.columns[at]!.from;
  let next = {
    ...merged.rules,
    output: { ...merged.rules.output, columns: merged.rules.output.columns.map((c, i) => (i === at ? { ...c, from: merged.from } : c)) },
    validations: withMarker,
    unsupported,
  } as R;
  if (ruleKey(next, column.header) === ruleKey(rules, column.header)) {
    // Same rule: keep the rules as they were (no new ids, no churn), with the marker as asked.
    return { ...rules, validations: withMarker, unsupported } as R;
  }
  if (old !== null && old !== merged.from) next = pruneComputed(next, [old]);
  return next;
}

/**
 * The default state of a question (what the free engine builds): the default reading, with the check that marks the question as open.
 * For an AI step's answer, which wrote the column its own way: the same example fits both, and the user decides.
 */
export function withOpenQuestion<R extends EditableRules>(rules: R, column: AmbiguousColumn): R | null {
  return applyReading(rules, column, column.defaultReading, true);
}
