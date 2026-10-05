// The lines of the rules map (SPEC 8.11) as ids, and what "Edited by you" and "This changes the format"
// mean in terms of them:
//
// - `lineIdsOf(rules)` lists every line id in map order. The ids are the contract with the rules map
//   (`col:<header>`, `readAs:<input id>:<text>`, `filter:<i>`, `dedupe`, `expand`, `sort`, `group`, `summary:end:<i>`,
//   `summary:group:<i>`, `title:<i>`, `check:<i>`, `fn:<name>`, `table:<name>`).
// - `editedLines(baseline, current)` compares what each line says with what it said when the editor
//   opened. List items are matched by content, so deleting filter 1 of 3 doesn't make filter 2 look edited.
// - `formatFingerprint(rules)` is what SPEC 8.12 calls the format side: output, sort and group by header,
//   summary rows, output validations. It mirrors the engine's `formatOf` (which the main thread can't load).
import type { OutputColumnRule, Validation } from '@formatai/shared';
import { DEFAULT_OUTPUT_FILE, isCodeCheck } from '@formatai/shared';
import { effectiveEndSummaryRows, effectiveGroupSummaryRows, stable, stableOf } from './rulesUtil';
import type { EditableRules, LineId } from './types';

export const lineIds = {
  col: (header: string): LineId => `col:${header}`,
  /** One text an input column reads as another value (SPEC 8.4a): the input column's id, the text exactly as written. */
  readAs: (columnId: string, from: string): LineId => `readAs:${columnId}:${from}`,
  filter: (i: number): LineId => `filter:${i}`,
  dedupe: 'dedupe' as LineId,
  expand: 'expand' as LineId,
  sort: 'sort' as LineId,
  group: 'group' as LineId,
  summaryEnd: (i: number): LineId => `summary:end:${i}`,
  summaryGroup: (i: number): LineId => `summary:group:${i}`,
  title: (i: number): LineId => `title:${i}`,
  check: (i: number): LineId => `check:${i}`,
  fn: (name: string): LineId => `fn:${name}`,
  table: (name: string): LineId => `table:${name}`,
};

const json = (v: unknown): string => (typeof v === 'object' && v !== null ? stableOf(v) : stable(v));

/** What a column line says: its output settings plus everything that makes its values (source, computed column, value map). */
function columnContent(rules: EditableRules, col: OutputColumnRule): string {
  const { header, from, format, width, agg } = col;
  let source: unknown = null;
  if (from !== null) {
    const computed = rules.transform.computed.find((c) => c.id === from);
    const input = rules.input.columns.find((c) => c.id === from);
    source = {
      from,
      computed: computed ? { type: computed.type, expr: computed.expr } : undefined,
      padLeft: input?.padLeft,
      valueMap: rules.transform.valueMaps.find((v) => v.column === from),
    };
  }
  return json({ header, format, width, agg, source });
}

interface Lines {
  /** Lines keyed by id: what each one says. */
  byId: Map<LineId, string>;
  /** List lines (by id): the multiset key they're matched with across edits. */
  listKinds: Map<LineId, string>;
}

function collect(rules: EditableRules): Lines {
  const byId = new Map<LineId, string>();
  const listKinds = new Map<LineId, string>();
  const list = (kind: string, id: LineId, content: unknown): void => {
    byId.set(id, json(content));
    listKinds.set(id, kind);
  };

  rules.output.columns.forEach((c) => byId.set(lineIds.col(c.header), columnContent(rules, c)));
  for (const c of rules.input.columns) {
    for (const [from, to] of Object.entries(c.readAs ?? {})) byId.set(lineIds.readAs(c.id, from), json(to));
  }
  (rules.input.rowFilters ?? []).forEach((f, i) => list('filter', lineIds.filter(i), f));
  if (rules.transform.dedupe) byId.set(lineIds.dedupe, json(rules.transform.dedupe));
  if (rules.transform.expand) byId.set(lineIds.expand, json(rules.transform.expand));
  if (rules.transform.sort.length > 0) byId.set(lineIds.sort, json(rules.transform.sort));
  const g = rules.transform.group;
  if (g) byId.set(lineIds.group, json({ by: g.by, showDetailRows: g.showDetailRows, blankRowsAfter: g.blankRowsAfter ?? 0 }));
  effectiveEndSummaryRows(rules).forEach((r, i) => list('summary:end', lineIds.summaryEnd(i), r));
  effectiveGroupSummaryRows(rules).forEach((r, i) => list('summary:group', lineIds.summaryGroup(i), r));
  rules.output.titleRows.forEach((t, i) => list('title', lineIds.title(i), t));
  rules.validations.forEach((v, i) => list('check', lineIds.check(i), v));
  (rules.transform.functions ?? []).forEach((f) => byId.set(lineIds.fn(f.name), json(f)));
  (rules.transform.tables ?? []).forEach((t) => byId.set(lineIds.table(t.name), json(t)));
  return { byId, listKinds };
}

/** Every line of the map, in map order: rows, columns, layout, checks, functions and tables. */
export function lineIdsOf(rules: EditableRules): LineId[] {
  return [...collect(rules).byId.keys()];
}

/** Columns that kept their content but moved: both neighbours differ from before. */
function movedColumns(baseline: EditableRules, current: EditableRules): Set<string> {
  const before = baseline.output.columns.map((c) => c.header);
  const after = current.output.columns.map((c) => c.header);
  const moved = new Set<string>();
  after.forEach((h, i) => {
    const j = before.indexOf(h);
    if (j < 0) return;
    const prevChanged = before[j - 1] !== after[i - 1];
    const nextChanged = before[j + 1] !== after[i + 1];
    if (prevChanged && nextChanged) moved.add(h);
  });
  return moved;
}

/** The lines of `current` whose content differs from `baseline` (new lines count as edited). */
export function editedLines(baseline: EditableRules, current: EditableRules): Set<LineId> {
  const before = collect(baseline);
  const after = collect(current);
  const edited = new Set<LineId>();

  // List lines: matched by content, as a multiset.
  const pool = new Map<string, number>();
  for (const [id, content] of before.byId) {
    const kind = before.listKinds.get(id);
    if (kind === undefined) continue;
    const key = `${kind}|${content}`;
    pool.set(key, (pool.get(key) ?? 0) + 1);
  }
  for (const [id, content] of after.byId) {
    const kind = after.listKinds.get(id);
    if (kind === undefined) {
      if (before.byId.get(id) !== content) edited.add(id);
      continue;
    }
    const key = `${kind}|${content}`;
    const n = pool.get(key) ?? 0;
    if (n > 0) pool.set(key, n - 1);
    else edited.add(id);
  }

  for (const h of movedColumns(baseline, current)) edited.add(lineIds.col(h));
  return edited;
}

// ---------- the format side (SPEC 8.12) ----------

function headerOfId(rules: EditableRules): Map<string, string> {
  const map = new Map<string, string>();
  for (const c of rules.output.columns) if (c.from !== null && !map.has(c.from)) map.set(c.from, c.header);
  return map;
}

function sortedValidations(list: readonly Validation[]): string[] {
  return list.map((v) => JSON.stringify(v, Object.keys(v).sort())).sort();
}

function aggByHeader(rules: EditableRules): Record<string, string> | undefined {
  const agg: Record<string, string> = {};
  let any = false;
  for (const c of rules.output.columns) {
    if (c.agg !== undefined) {
      agg[c.header] = c.agg;
      any = true;
    }
  }
  return any ? agg : undefined;
}

/**
 * Two rules files have the same fingerprint exactly when the engine's `formatOf` gives them equal formats:
 * the output (except where each column comes from), sort and group by output header, summary rows, and the
 * output validations. (Checked against `formatOf` in the editor tests.)
 */
export function formatFingerprint(rules: EditableRules): string {
  const idToHeader = headerOfId(rules);
  const toHeader = (id: string): string => idToHeader.get(id) ?? id;
  const g = rules.transform.group;
  return json({
    file: rules.output.file ?? DEFAULT_OUTPUT_FILE,
    sheetName: rules.output.sheetName,
    direction: rules.output.direction,
    language: rules.output.language,
    titleRows: rules.output.titleRows,
    headerStyle: rules.output.headerStyle,
    summaryRows: effectiveEndSummaryRows(rules),
    columns: rules.output.columns.map((c) => ({ header: c.header, format: c.format, width: c.width, agg: c.agg })),
    sort: rules.transform.sort.map((s) => ({ header: toHeader(s.column), dir: s.dir })),
    group: g
      ? {
          by: toHeader(g.by),
          showDetailRows: g.showDetailRows,
          blankRowsAfter: g.blankRowsAfter,
          summaryRows: effectiveGroupSummaryRows(rules),
          agg: aggByHeader(rules),
        }
      : undefined,
    outputValidations: sortedValidations(rules.validations.filter((v) => (v.on ?? 'input') === 'output')),
  });
}

// ---------- the source side (SPEC 8.15) ----------

const sortedStrings = (list: readonly string[] | undefined): string[] => [...(list ?? [])].sort();

/** The input validations as a source keeps them: by the input column's header, `on: "input"` dropped, as a sorted set. A check only code
 * writes (a cut-off, an open question's marker: SPEC 8.8) is the conversion's own, never the source's (the engine's `isSourceCheck`). */
function inputValidationKeys(rules: EditableRules): string[] {
  const idToHeader = new Map(rules.input.columns.map((c) => [c.id, c.header] as const));
  return rules.validations
    .filter((v) => (v.on ?? 'input') !== 'output' && !isCodeCheck(v))
    .map((v) => {
      const { on: _on, ...rest } = v;
      return stable({ ...rest, column: idToHeader.get(v.column) ?? v.column });
    })
    .sort();
}

/**
 * Whether `after` changes the INPUT side of `before` - what SPEC 8.15 calls editing the source: the sheet pick, header row, stop rule
 * or input checks differ, or a column it declares has another header, aliases, type, padding, date formats or readAs (SPEC 8.4a) - or is a column
 * `before` did not declare. The mirror (for the main thread, which can't load the engine) of what the server's source lock treats
 * as a source edit.
 *
 * DECISION: a column the rules stop declaring is NOT a change: a source keeps its columns (a conversion may read a subset). A column
 * `after` declares that `before` did not counts as one, although the source may already have it: the browser doesn't know the source's
 * other columns, and the answer after saving says what really happened (`sourceChanged`).
 */
export function inputSideChanged(before: EditableRules, after: EditableRules): boolean {
  const reading = (r: EditableRules): string => stable({ sheet: r.input.sheet, headerRow: r.input.headerRow, stopAt: r.input.stopAt });
  if (reading(before) !== reading(after)) return true;
  if (inputValidationKeys(before).join('\u0000') !== inputValidationKeys(after).join('\u0000')) return true;

  const was = new Map(before.input.columns.map((c) => [c.id, c] as const));
  const shape = (c: EditableRules['input']['columns'][number]): string =>
    stable({ header: c.header, aliases: sortedStrings(c.aliases), type: c.type, padLeft: c.padLeft, inputFormats: c.inputFormats, readAs: c.readAs });
  return after.input.columns.some((c) => {
    const old = was.get(c.id);
    return old === undefined || shape(old) !== shape(c);
  });
}
