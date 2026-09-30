// Turns the ids inside the rules (internal, machine-made) into names a person knows.
//   - an input column id          -> the input file's header
//   - an id made by the transform -> the header of the output column that shows it
//   - a helper that no output column shows -> its calculation is written inline (`hidden`)
//   - anything else               -> the id spelled out ("signedAmount" -> "Signed amount")
import type { ColumnType, Computed, Expr, LearnResult, Rules } from '@formatai/shared';

export interface Names {
  /** The name to show for an id (never the raw id when a better one exists). */
  display(id: string): string;
  /** Like `display`, but prefers the header of the output column that shows the id: the name the result uses. */
  output(id: string): string;
  /** The calculation behind a computed id that no output column shows, if any. */
  hidden(id: string): Expr | undefined;
  /** The value type of an id, when the rules declare one. */
  typeOf(id: string): ColumnType | undefined;
  /** What an id made by the expand step stands for, when no column shows it and no input column has that id. */
  made(id: string): 'label' | 'value' | 'part' | 'index' | 'count' | undefined;
  /** True when the rules define this id (input column, computed, or made by expand). */
  known(id: string): boolean;
}

/** "signedAmount" -> "Signed amount", "txn_id" -> "Txn id". Non-Latin ids are left alone. */
export function humanizeId(id: string): string {
  const spaced = id
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-.]+/g, ' ')
    .trim();
  if (spaced === '') return id;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

export function buildNames(rules: LearnResult | Rules): Names {
  const inputHeader = new Map<string, string>();
  const types = new Map<string, ColumnType>();
  for (const c of rules.input.columns) {
    inputHeader.set(c.id, c.header);
    types.set(c.id, c.type);
  }

  const outputHeader = new Map<string, string>();
  for (const c of rules.output.columns) {
    if (c.from !== null && !outputHeader.has(c.from)) outputHeader.set(c.from, c.header);
  }

  const computed = new Map<string, Computed>();
  for (const c of rules.transform.computed) {
    computed.set(c.id, c);
    types.set(c.id, c.type);
  }

  const made = new Set<string>();
  const madeKind = new Map<string, 'label' | 'value' | 'part' | 'index' | 'count'>();
  const expand = rules.transform.expand;
  if (expand?.mode === 'columnsToRows') {
    made.add(expand.labelId);
    made.add(expand.valueId);
    madeKind.set(expand.labelId, 'label');
    madeKind.set(expand.valueId, 'value');
    types.set(expand.labelId, 'text');
    types.set(expand.valueId, expand.valueType);
  } else if (expand?.mode === 'splitCell') {
    made.add(expand.partId);
    madeKind.set(expand.partId, 'part');
    types.set(expand.partId, 'text');
    if (expand.indexId) {
      made.add(expand.indexId);
      madeKind.set(expand.indexId, 'index');
      types.set(expand.indexId, 'integer');
    }
    if (expand.countId) {
      made.add(expand.countId);
      madeKind.set(expand.countId, 'count');
      types.set(expand.countId, 'integer');
    }
  } else if (expand?.mode === 'fixedFanOut') {
    for (const row of expand.rows) for (const key of Object.keys(row.set)) made.add(key);
  }

  return {
    display: (id) => inputHeader.get(id) ?? outputHeader.get(id) ?? humanizeId(id),
    output: (id) => outputHeader.get(id) ?? inputHeader.get(id) ?? humanizeId(id),
    hidden: (id) => {
      if (inputHeader.has(id) || outputHeader.has(id)) return undefined;
      return computed.get(id)?.expr;
    },
    made: (id) => (inputHeader.has(id) || outputHeader.has(id) ? undefined : madeKind.get(id)),
    typeOf: (id) => types.get(id),
    known: (id) => inputHeader.has(id) || computed.has(id) || made.has(id),
  };
}
