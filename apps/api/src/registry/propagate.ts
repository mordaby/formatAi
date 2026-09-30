// SPEC 8.12 "Editing a format": a change to the output side made from any conversion's rules map is a change to
// the FORMAT, and on save it is written to every conversion of that format. This file is that write, as pure
// functions: `headerRenames` reads what the edit renamed, `applyFormat` rebuilds one other conversion's rules
// around the new format.
//
// What a conversion keeps and what it takes from the format:
//   * it keeps its input side and its transform (computed columns, value maps, functions, tables, filters ...)
//     and its own input-side validations - none of that is the format's;
//   * it takes the format's `output` (columns, headers, formats, widths, title rows, summary rows, file ...),
//     the format's `sort` and `group` (the format names them by OUTPUT HEADER; here they are turned back into
//     this conversion's own ids), and the format's output validations;
//   * each output column keeps ITS OWN `from`: the column is found by header - or by its old header, when the
//     edit renamed it - so an unrelated edit (a new width, a reorder, a rename) leaves every mapping in place.
//
// A conversion is left `needsReview` (SPEC 8.12: "Conversions whose `from` references still resolve keep their
// status; the others become `needsReview`") when the rebuilt rules do not resolve: a column the format gained
// that this source has no mapping for (it becomes `unsupported`, and the user decides), or any reference (a
// title row's aggregate column, a sort or group key, ...) to something this conversion does not have.
import { checkFormatLock, typeCheck } from '@formatai/engine';
import {
  checkRules,
  type Assumption,
  type Format,
  type Group,
  type LearnResult,
  type OutputColumnRule,
  type RepairProblem,
  type Rules,
  type RulesOutput,
  type RulesTransform,
  type SortKey,
  type Unsupported,
} from '@formatai/shared';

/**
 * Which output columns an edit renamed: new header -> old header. A column counts as renamed when its header is
 * new, it reads from something (`from`), and exactly that source fed a column whose header is gone - or, for a
 * column that reads from nothing (unsupported), when it stands where such a column with a vanished header stood.
 */
export function headerRenames(before: Rules | LearnResult, after: Rules | LearnResult): Map<string, string> {
  const oldColumns = before.output.columns;
  const oldHeaders = new Set(oldColumns.map((c) => c.header));
  const newHeaders = new Set(after.output.columns.map((c) => c.header));
  const claimed = new Set<string>();
  const renames = new Map<string, string>();
  after.output.columns.forEach((column, i) => {
    if (oldHeaders.has(column.header)) return;
    const free = (c: OutputColumnRule | undefined): c is OutputColumnRule =>
      c !== undefined && !newHeaders.has(c.header) && !claimed.has(c.header);
    const old =
      column.from === null
        ? [oldColumns[i]].find((c) => c?.from === null && free(c))
        : oldColumns.find((c) => c.from === column.from && free(c));
    if (old) {
      renames.set(column.header, old.header);
      claimed.add(old.header);
    }
  });
  return renames;
}

export interface Propagated {
  /** The conversion's rules rebuilt around the new format (its `meta.status` is set by the caller). */
  rules: Rules;
  /** The rebuilt rules do not resolve, or the source lacks a column the format gained. */
  needsReview: boolean;
  /** Headers of the columns the format gained that this source cannot produce (now `unsupported`). */
  newColumns: string[];
  /** Why the rebuilt rules do not resolve (references, types, format lock); empty when they do. */
  problems: RepairProblem[];
}

/** Rebuilds `target` (one other conversion of the format) around `format`, the format after the edit. */
export function applyFormat(target: Rules, format: Format, renames: ReadonlyMap<string, string>): Propagated {
  const oldFromByHeader = new Map<string, string | null>();
  for (const c of target.output.columns) if (!oldFromByHeader.has(c.header)) oldFromByHeader.set(c.header, c.from);

  // ----- output columns: the format's, each with this conversion's own `from` -----
  const newColumns: string[] = [];
  const columns: OutputColumnRule[] = format.output.columns.map((fc) => {
    const sourceHeader = renames.get(fc.header) ?? fc.header;
    const known = oldFromByHeader.has(sourceHeader);
    if (!known) newColumns.push(fc.header);
    const column: OutputColumnRule = { header: fc.header, from: known ? (oldFromByHeader.get(sourceHeader) ?? null) : null };
    if (fc.format !== undefined) column.format = fc.format;
    if (fc.width !== undefined) column.width = fc.width;
    if (fc.agg !== undefined) column.agg = fc.agg;
    return column;
  });

  const output: RulesOutput = {
    file: format.output.file,
    sheetName: format.output.sheetName,
    direction: format.output.direction,
    language: format.output.language,
    titleRows: format.output.titleRows,
    columns,
    // The deprecated id-based `grandTotal` is dropped: the format's summary rows (already header-keyed) replace it.
    summaryRows: format.output.summaryRows,
  };
  if (format.output.headerStyle !== undefined) output.headerStyle = format.output.headerStyle;

  // ----- sort and group: the format's output headers back to this conversion's ids -----
  const idOfHeader = (header: string): string => columns.find((c) => c.header === header)?.from ?? header;
  const sort: SortKey[] = format.layout.sort.map((k) => ({ column: idOfHeader(k.header), dir: k.dir }));
  const transform: RulesTransform = { ...target.transform, sort };
  delete transform.group;
  if (format.layout.group) {
    const g = format.layout.group;
    const group: Group = { by: idOfHeader(g.by), showDetailRows: g.showDetailRows, summaryRows: g.summaryRows };
    if (g.blankRowsAfter !== undefined) group.blankRowsAfter = g.blankRowsAfter;
    transform.group = group;
  }

  // ----- what was said about output columns follows the columns (renamed ones by their new header) -----
  const oldToNew = new Map<string, string>();
  for (const [next, old] of renames) oldToNew.set(old, next);
  const newHeaders = new Set(columns.map((c) => c.header));
  const fromOf = new Map(columns.map((c) => [c.header, c.from] as const));
  const follow = (header: string): string | undefined => {
    const h = oldToNew.get(header) ?? header;
    return newHeaders.has(h) ? h : undefined;
  };

  const unsupported: Unsupported[] = [];
  for (const u of target.unsupported) {
    const h = follow(u.outputColumn);
    if (h !== undefined && fromOf.get(h) === null && !unsupported.some((x) => x.outputColumn === h)) {
      unsupported.push({ ...u, outputColumn: h });
    }
  }
  for (const h of newColumns) unsupported.push({ outputColumn: h, reasonCode: 'other' });

  const assumptions: Assumption[] = [];
  for (const a of target.assumptions) {
    if (a.outputColumn === undefined) {
      assumptions.push(a);
      continue;
    }
    const h = follow(a.outputColumn);
    if (h !== undefined) assumptions.push({ ...a, outputColumn: h });
  }

  const next: Rules = {
    ...target,
    transform,
    output,
    // This conversion's own (input-side) validations stay; the format's output validations are the format's.
    validations: [...target.validations.filter((v) => (v.on ?? 'input') === 'input'), ...format.outputValidations],
    unsupported,
    assumptions,
  };

  const problems: RepairProblem[] = [];
  for (const p of checkRules(next)) problems.push({ kind: 'reference', message: p.path ? `${p.path}: ${p.message}` : p.message });
  for (const p of typeCheck(next)) problems.push({ kind: 'type', path: p.path, message: p.message });
  for (const p of checkFormatLock(next, format)) problems.push({ kind: 'formatMismatch', path: p.path, message: p.message });

  return { rules: next, needsReview: problems.length > 0 || newColumns.length > 0, newColumns, problems };
}
