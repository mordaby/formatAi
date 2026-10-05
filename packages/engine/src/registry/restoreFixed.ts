// Completion mode: an answer that changed or dropped part of the rules it was told to keep (the fixed lock's `fixedMismatch`,
// `checkFixedLock`) gets those parts put back by code, from the fixed rules, instead of being thrown away (docs/proposals/
// learning-loop.md 3.2, "Fixed columns are put back by code"). The checks then run again on what comes out and decide, as always:
// what code cannot put back - a new value map on a column a fixed output column reads, a listed column with no rule - is still a
// `fixedMismatch` for a repair round, and an answer whose new parts relied on the part it changed fails its other checks there.
//
// What is put back is exactly what the lock holds: every fixed input column, computed column, function and table (by id or name, the
// fixed version, fixed ones first so every reference they make still comes before its use), every fixed value map and check;
// `input.sheet` / `headerRow` / `stopAt`; the output file settings, sheet name, direction, language and header style; every output
// column's header, format, width and agg, and the `from` and `unsupported` entry of every column that was not asked for; and each layout
// part that was not asked for (`complete.parts`), whole. A part that was asked for keeps what the answer built, plus whatever fixed
// element of it the answer dropped.
//
// DECISION: a value map the answer wrote on a column a fixed value map already maps is replaced by the fixed one (two maps on one column
// would apply both); every other value map of the answer stays - a NEW one on a column a fixed output column reads is the lock's to
// report, since dropping it would silently break the column the answer built with it.
// DECISION: when the answer has a different number of output columns, they are rebuilt from the fixed ones, and an asked-for column takes
// the `from` of the answer's column with the same header (none: it stays without a rule, which the lock then reports).
//
// Pure: used by the API (on the wire-decoded answer and `complete.fixed`, both masked when masking is on) and by the browser (on the
// unmasked answer and the real fixed rules).
import type { LearnResult, OutputColumnRule, Rules, SummaryRow, TitleRow } from '@formatai/shared';
import { learnResultOf } from '@formatai/shared';
import { canonicalizeRules } from '../formula/canonicalize';
import type { FixedLockOptions } from './checkFixedLock';
import { deepEqual } from './deepEqual';

/** The elements of `fixed` that `have` lacks (a multiset difference, by deep equality on the canonical forms `fixedCanon`/`haveCanon`). */
function missingFrom<T>(have: readonly unknown[], fixedCanon: readonly unknown[], fixed: readonly T[]): T[] {
  const left = [...have];
  const missing: T[] = [];
  fixedCanon.forEach((f, i) => {
    const at = left.findIndex((h) => deepEqual(h, f));
    if (at >= 0) left.splice(at, 1);
    else missing.push(fixed[i]!);
  });
  return missing;
}

/** By key: the fixed elements (the fixed version), then the answer's elements whose key no fixed element has. */
function byKey<T>(answer: readonly T[], fixed: readonly T[], key: (x: T) => string): T[] {
  const fixedKeys = new Set(fixed.map(key));
  return [...fixed, ...answer.filter((x) => !fixedKeys.has(key(x)))];
}

/**
 * `answer` with every part of `fixed` that the fixed lock holds put back (see the file header). The answer's own additions (new ids,
 * input and computed columns, functions, tables, the asked-for columns' rules and parts) are kept. Returns a new object.
 */
export function restoreFixed(answer: LearnResult, fixedRules: LearnResult | Rules, opts: FixedLockOptions): LearnResult {
  const fixed = learnResultOf(fixedRules);
  const a = canonicalizeRules(answer);
  const f = canonicalizeRules(fixed);
  const parts = new Set(opts.parts);
  const asked = new Set(opts.columns);

  // ---- input ----
  const answerFilters = answer.input.rowFilters ?? [];
  const fixedFilters = fixed.input.rowFilters ?? [];
  const rowFilters = parts.has('droppedRows') ? [...answerFilters, ...missingFrom(a.input.rowFilters ?? [], f.input.rowFilters ?? [], fixedFilters)] : fixedFilters;
  const input: LearnResult['input'] = {
    sheet: fixed.input.sheet,
    headerRow: fixed.input.headerRow,
    ...(fixed.input.stopAt !== undefined ? { stopAt: fixed.input.stopAt } : {}),
    columns: byKey(answer.input.columns, fixed.input.columns, (c) => c.id),
    ...(rowFilters.length > 0 ? { rowFilters } : {}),
  };

  // ---- transform ----
  const at = answer.transform;
  const ft = fixed.transform;
  const dedupe = ft.dedupe ?? (parts.has('droppedRows') ? at.dedupe : undefined);
  const expand = ft.expand ?? (parts.has('rows') ? at.expand : undefined);
  const fixedMapped = new Set(ft.valueMaps.map((m) => m.column));
  const valueMaps = [...ft.valueMaps, ...at.valueMaps.filter((m) => !fixedMapped.has(m.column))];
  const sort = parts.has('sort') ? [...at.sort, ...missingFrom(a.transform.sort, f.transform.sort, ft.sort)] : ft.sort;
  let group = at.group;
  if (ft.group === undefined) {
    if (!parts.has('group')) group = undefined;
  } else if (at.group === undefined) {
    group = ft.group;
  } else {
    const fg = ft.group;
    const ag = at.group;
    const groupAsked = parts.has('group');
    const summaryAsked = groupAsked || parts.has('summaryRows');
    const summaryRows: SummaryRow[] = summaryAsked
      ? [...(ag.summaryRows ?? []), ...missingFrom(a.transform.group?.summaryRows ?? [], f.transform.group?.summaryRows ?? [], fg.summaryRows ?? [])]
      : (fg.summaryRows ?? []);
    group = {
      ...ag,
      ...(groupAsked ? {} : { by: fg.by, showDetailRows: fg.showDetailRows }),
      ...(groupAsked || parts.has('blankRows') ? {} : { blankRowsAfter: fg.blankRowsAfter }),
      summaryRows,
    };
    if (group.blankRowsAfter === undefined) delete group.blankRowsAfter;
    if (summaryRows.length === 0 && fg.summaryRows === undefined && ag.summaryRows === undefined) delete group.summaryRows;
  }
  const functions = byKey(at.functions ?? [], ft.functions ?? [], (x) => x.name);
  const tables = byKey(at.tables ?? [], ft.tables ?? [], (x) => x.name);
  const transform: LearnResult['transform'] = {
    ...(dedupe !== undefined ? { dedupe } : {}),
    ...(expand !== undefined ? { expand } : {}),
    computed: byKey(at.computed, ft.computed, (c) => c.id),
    valueMaps,
    sort,
    ...(group !== undefined ? { group } : {}),
    ...(functions.length > 0 ? { functions } : {}),
    ...(tables.length > 0 ? { tables } : {}),
  };

  // ---- output ----
  const ao = answer.output;
  const fo = fixed.output;
  const columns: OutputColumnRule[] = fo.columns.map((fc, i) => {
    if (!asked.has(i)) return fc;
    const mine = ao.columns.length === fo.columns.length ? ao.columns[i] : ao.columns.find((c) => c.header === fc.header);
    return { ...fc, from: mine?.from ?? null };
  });
  const titleRows: TitleRow[] = parts.has('dateTitle') ? [...ao.titleRows, ...missingFrom(a.output.titleRows, f.output.titleRows, fo.titleRows)] : fo.titleRows;
  const summaryRows: SummaryRow[] = parts.has('summaryRows')
    ? [...(ao.summaryRows ?? []), ...missingFrom(a.output.summaryRows ?? [], f.output.summaryRows ?? [], fo.summaryRows ?? [])]
    : (fo.summaryRows ?? []);
  const output: LearnResult['output'] = {
    ...(fo.file !== undefined ? { file: fo.file } : {}),
    sheetName: fo.sheetName,
    direction: fo.direction,
    language: fo.language,
    titleRows,
    columns,
    ...(fo.headerStyle !== undefined ? { headerStyle: fo.headerStyle } : {}),
    ...(summaryRows.length > 0 || fo.summaryRows !== undefined ? { summaryRows } : {}),
  };

  // ---- checks and unsupported ----
  // (A column that was not asked for is the fixed one, "unsupported" or not: the answer's entries are kept for the asked-for columns only.)
  const validations = [...answer.validations, ...missingFrom(a.validations, f.validations, fixed.validations)];
  const askedHeaders = new Set([...asked].map((i) => fo.columns[i]?.header).filter((h): h is string => h !== undefined));
  const fixedHeaders = new Set(fo.columns.map((c) => c.header));
  const unsupported = [
    ...answer.unsupported.filter((u) => askedHeaders.has(u.outputColumn) || !fixedHeaders.has(u.outputColumn)),
    ...fixed.unsupported.filter((u) => !askedHeaders.has(u.outputColumn)),
  ];

  return { schemaVersion: answer.schemaVersion, input, transform, output, validations, unsupported, assumptions: answer.assumptions };
}
