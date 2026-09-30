// SPEC 8.12/21 (M0 amendment): "a pure function `formatOf(rules)` that extracts the
// format side (output, sort and group normalized to output headers, output
// validations)." SPEC 8.12: "It holds: `output` (... except `columns[].from`); the
// layout parts that live in `transform`, normalized to output headers: `sort`, and
// `group` (...); output validations (`on: 'output'`)."
//
// v4 change (SPEC 21): `output.grandTotal`/`group.subtotal` (deprecated, id-based) are
// normalized into `summaryRows` (header-keyed, SPEC 8.12) via
// `packages/engine/src/rules/summaryRows.ts` - the SAME normalization the engine's
// runtime layout (pipeline/v1/layout.ts) uses, so an old-style conversion (still
// written with the deprecated fields) and a new-style one (written with
// `summaryRows` directly) produce the identical `Format` and compare equal.
import type {
  Format,
  FormatGroup,
  FormatOutput,
  FormatOutputColumn,
  FormatSortKey,
  LearnResult,
  OutputColumnAgg,
  Rules,
} from '@formatai/shared';
import { DEFAULT_OUTPUT_FILE } from '@formatai/shared';
import { effectiveGroupSummaryRows, effectiveOutputSummaryRows } from '../rules/summaryRows';

/**
 * Maps every id that feeds an output column to that column's header (first match wins
 * when several output columns share the same `from`).
 *
 * DECISION: SPEC 8.12 says the layout is "normalized to output headers" but doesn't
 * say what to do when a `sort`/`group` id isn't fed to any output column at all (e.g.
 * sorting by a column the output doesn't show). Rather than making `formatOf` fallible
 * for a case the spec leaves open, the id itself is kept as a best-effort header
 * string. That keeps `formatOf` total and deterministic, and it still makes
 * `checkFormatLock`'s comparison fail loudly - as a header mismatch - if two
 * conversions of the same format disagree about which unshown id they sort/group by,
 * rather than silently treating them as equal.
 */
function buildIdToHeader(rules: LearnResult | Rules): Map<string, string> {
  const map = new Map<string, string>();
  for (const col of rules.output.columns) {
    if (col.from !== null && !map.has(col.from)) map.set(col.from, col.header);
  }
  return map;
}

function toHeader(id: string, idToHeader: ReadonlyMap<string, string>): string {
  return idToHeader.get(id) ?? id;
}

function normalizeOutput(rules: LearnResult | Rules): FormatOutput {
  const columns: FormatOutputColumn[] = rules.output.columns.map((c) => {
    const col: FormatOutputColumn = { header: c.header };
    if (c.format !== undefined) col.format = c.format;
    if (c.width !== undefined) col.width = c.width;
    if (c.agg !== undefined) col.agg = c.agg;
    return col;
  });

  const output: FormatOutput = {
    // SPEC 8.13: "The default is `{ type: 'xlsx' }`" - made explicit here so a stored
    // Format never has to special-case an absent `file` again.
    file: rules.output.file ?? DEFAULT_OUTPUT_FILE,
    sheetName: rules.output.sheetName,
    direction: rules.output.direction,
    language: rules.output.language,
    titleRows: rules.output.titleRows,
    columns,
    // SPEC 8.12/21 v4: `output.summaryRows` as-is, or the deprecated `grandTotal`
    // translated (never both - see `effectiveOutputSummaryRows`).
    summaryRows: effectiveOutputSummaryRows(rules.output, rules.transform.group).rows,
  };
  if (rules.output.headerStyle !== undefined) output.headerStyle = rules.output.headerStyle;
  return output;
}

function normalizeSort(rules: LearnResult | Rules, idToHeader: ReadonlyMap<string, string>): FormatSortKey[] {
  return rules.transform.sort.map((s) => ({ header: toHeader(s.column, idToHeader), dir: s.dir }));
}

/** SPEC 8.6: summary outputs give each output column an `agg`. It already lives on the
 * column (kept in `FormatOutputColumn.agg` above); this re-shapes it into the
 * `Record<header, agg>` SPEC 8.12/LEARN_PROMPT §3's `target.layout.group.agg` uses. */
function buildAggByHeader(rules: LearnResult | Rules): Record<string, OutputColumnAgg> | undefined {
  const agg: Record<string, OutputColumnAgg> = {};
  let any = false;
  for (const c of rules.output.columns) {
    if (c.agg !== undefined) {
      agg[c.header] = c.agg;
      any = true;
    }
  }
  return any ? agg : undefined;
}

function normalizeGroup(rules: LearnResult | Rules, idToHeader: ReadonlyMap<string, string>): FormatGroup | undefined {
  const g = rules.transform.group;
  if (!g) return undefined;

  const group: FormatGroup = {
    by: toHeader(g.by, idToHeader),
    showDetailRows: g.showDetailRows,
    // SPEC 8.12/21 v4: `group.summaryRows` as-is, or the deprecated `subtotal`
    // translated (never both - see `effectiveGroupSummaryRows`).
    summaryRows: effectiveGroupSummaryRows(g, rules.output.columns).rows,
  };
  if (g.blankRowsAfter !== undefined) group.blankRowsAfter = g.blankRowsAfter;
  const agg = buildAggByHeader(rules);
  if (agg) group.agg = agg;
  return group;
}

/** Extracts the format side of a conversion's rules (SPEC 8.12): what every other
 * source attached to the same format must reproduce (SPEC 8.12 "the format lock",
 * enforced by `checkFormatLock`). Pure; never mutates `rules`. */
export function formatOf(rules: LearnResult | Rules): Format {
  const idToHeader = buildIdToHeader(rules);
  const group = normalizeGroup(rules, idToHeader);

  return {
    output: normalizeOutput(rules),
    layout: {
      sort: normalizeSort(rules, idToHeader),
      ...(group ? { group } : {}),
    },
    // SPEC 8.8/8.12: validations with `on: 'output'` belong to the format.
    outputValidations: rules.validations.filter((v) => (v.on ?? 'input') === 'output'),
  };
}
