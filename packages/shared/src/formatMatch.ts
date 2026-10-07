// Is a learned example the SAME FORMAT as a saved one? (owner decision 2026-10-07, SPEC 8.12 "A new example that matches a saved format")
// Decided by the OUTPUT only: the input's column names never count (one format can have many sources). Two formats are the same when the
// STRUCTURE of their output is equal:
//   - the output column headers, in order (spaces around a header, and runs of spaces inside it, do not count; nothing else is loosened);
//   - the file kind (xlsx / csv / txt) and whether it has a header row;
//   - the layout's structure: the title rows (how many, and which of them is blank - never their text, which changes from month to month:
//     "Report for March"), the summary rows (in order: which columns they fill and with which aggregate - not the label), and the grouping
//     (by which column, with or without the detail rows, the per-column aggregates, and the group's summary rows).
// Not compared: number and date formats, widths, sheet name, direction, language, header style, sort, delimiter / encoding / quoting, the
// summary rows' labels, and the output checks. DECISION: those are the format lock's (`checkFormatLock`, SPEC 8.12), which decides whether
// the file can be ADDED as a source of the format; two outputs that differ only there still look like one format to the person who made them.
// A file with no header row (`file.header: false`) never matches: its headers are names code made up, and a column count alone is a guess.
// Pure; the browser runs it (in the worker, on `formatOf` of the learned rules) against the user's saved formats.
import type { Format, FormatGroup } from './format';
import type { LearnResult, Rules, SummaryRow } from './rules/schema';

/** A header as the comparison reads it: trimmed, with every run of whitespace one space. */
export function normalizeOutputHeader(header: string): string {
  return header.replace(/\s+/g, ' ').trim();
}

interface SummaryShape {
  /** `[header, aggregate]`, sorted by header. */
  cells: [string, string][];
}

interface GroupShape {
  by: string;
  showDetailRows: boolean;
  agg: [string, string][];
  summaryRows: SummaryShape[];
}

/** What `sameOutputStructure` compares (see the file header). */
export interface OutputStructure {
  headers: string[];
  fileType: string;
  headerRow: boolean;
  /** One entry per title row: a blank one, or a line (whatever its text). */
  titleRows: ('blank' | 'line')[];
  summaryRows: SummaryShape[];
  group: GroupShape | null;
}

function sortedPairs(record: Readonly<Record<string, string>> | undefined): [string, string][] {
  return Object.entries(record ?? {})
    .map(([header, agg]): [string, string] => [normalizeOutputHeader(header), agg])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function summaryShape(row: SummaryRow): SummaryShape {
  return { cells: sortedPairs(row.cells) };
}

function groupShape(group: FormatGroup | undefined): GroupShape | null {
  if (!group) return null;
  return {
    by: normalizeOutputHeader(group.by),
    showDetailRows: group.showDetailRows,
    agg: sortedPairs(group.agg),
    summaryRows: (group.summaryRows ?? []).map(summaryShape),
  };
}

/** The structure of a format's output, or null when it has no header row (it is never compared). */
export function outputStructureOf(format: Format): OutputStructure | null {
  const file = format.output.file ?? { type: 'xlsx' };
  if (file.header === false) return null;
  return {
    headers: format.output.columns.map((c) => normalizeOutputHeader(c.header)),
    fileType: file.type,
    headerRow: true,
    titleRows: (format.output.titleRows ?? []).map((row) => ('blank' in row ? 'blank' : 'line')),
    summaryRows: (format.output.summaryRows ?? []).map(summaryShape),
    group: groupShape(format.layout?.group),
  };
}

/** True when the two outputs have the same structure (see the file header). Never true for an output with no header row or no columns. */
export function sameOutputStructure(a: Format, b: Format): boolean {
  const x = outputStructureOf(a);
  const y = outputStructureOf(b);
  if (!x || !y || x.headers.length === 0) return false;
  return JSON.stringify(x) === JSON.stringify(y);
}

/**
 * SPEC 8.13: a csv or txt file has no sheet, widths, header style or direction - none of them is written - and code names a csv's "sheet" after
 * the file ("orders 2026-09"). Rules learned from such an output take the format's, so a new file name is not a difference from the format
 * (the file written is the same, byte for byte). Any other output, or one of another file type or width, is returned as it is.
 */
export function withUnwrittenOutputOf<R extends LearnResult | Rules>(rules: R, format: Format): R {
  const type = rules.output.file?.type ?? 'xlsx';
  if (type === 'xlsx' || type !== (format.output.file?.type ?? 'xlsx') || rules.output.columns.length !== format.output.columns.length) return rules;
  const { headerStyle: _style, ...output } = rules.output;
  return {
    ...rules,
    output: {
      ...output,
      sheetName: format.output.sheetName,
      direction: format.output.direction,
      ...(format.output.headerStyle !== undefined ? { headerStyle: format.output.headerStyle } : {}),
      columns: rules.output.columns.map((c, i) => {
        const { width: _width, ...column } = c;
        const width = format.output.columns[i]!.width;
        return width !== undefined ? { ...column, width } : column;
      }),
    },
  };
}
