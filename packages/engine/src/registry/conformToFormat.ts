// Add a source, the free engine first (owner decision 2026-10-07, SPEC 5 A2): the rules code built from a source's example pair, given the
// output side of the format they must produce. The format lock (SPEC 8.12) holds the output side exactly, so it is not learned again - it is
// TAKEN from the format: the file settings, sheet name, direction, language, header style, every column's header, number format, width and
// aggregate (each column keeps its own `from`), the summary rows (keyed by output header), and the output checks. What the format says by
// output header and a conversion says by id is translated through the columns' `from`:
//   - the sort: each key's header -> the id that feeds that output column;
//   - the grouping: `by` the same way, with the format's detail rows, blank rows and summary rows.
// A part that cannot be translated - a sort or group by a column no rule fills yet, a title row that reads a column these rules don't declare
// (title rows keep the ids of the format's first source, `format.ts`) - keeps the rules' own and is listed as `unresolved`: the AI step
// (attach mode, `target`) has to build it, and until then the format lock says it differs.
// Pure; the rows the rules make may change (the format's number formats, say), so the caller verifies the result against the example.
import { type AiStepPartCode, type Format, type LearnResult, type Rules, type RulesOutput, type TitleRow } from '@formatai/shared';
import { deepEqual } from './deepEqual';

export interface ConformResult {
  rules: LearnResult;
  /** The format's parts these rules cannot take by code alone (they keep their own): the AI step has to build them. */
  unresolved: AiStepPartCode[];
  /** The parts the format supplied, so nothing has to learn them any more. */
  supplied: AiStepPartCode[];
}

function declaredIds(rules: LearnResult | Rules): Set<string> {
  return new Set([...rules.input.columns.map((c) => c.id), ...rules.transform.computed.map((c) => c.id)]);
}

function titleRowsFit(rows: readonly TitleRow[], ids: ReadonlySet<string>): boolean {
  return rows.every((row) => !('parts' in row) || row.parts.every((part) => !('agg' in part) || ids.has(part.column)));
}

export function conformToFormat(rules: LearnResult, format: Format): ConformResult {
  const out = format.output;
  if (rules.output.columns.length !== out.columns.length) return { rules, unresolved: [], supplied: [] };

  const unresolved: AiStepPartCode[] = [];
  const supplied: AiStepPartCode[] = ['summaryRows'];
  // The format's header -> the id that fills that column in these rules (columns line up by position).
  const idOf = new Map<string, string>();
  rules.output.columns.forEach((c, i) => {
    const header = out.columns[i]!.header;
    if (c.from !== null && !idOf.has(header)) idOf.set(header, c.from);
  });

  // ---- the output side ----
  const titleOk = titleRowsFit(out.titleRows, declaredIds(rules));
  if (titleOk) supplied.push('dateTitle');
  else if (!deepEqual(rules.output.titleRows, out.titleRows)) unresolved.push('dateTitle');
  const output: RulesOutput = {
    file: out.file,
    sheetName: out.sheetName,
    direction: out.direction,
    language: out.language,
    titleRows: titleOk ? out.titleRows : rules.output.titleRows,
    columns: out.columns.map((c, i) => ({
      header: c.header,
      from: rules.output.columns[i]!.from,
      ...(c.format !== undefined ? { format: c.format } : {}),
      ...(c.width !== undefined ? { width: c.width } : {}),
      ...(c.agg !== undefined ? { agg: c.agg } : {}),
    })),
    ...(out.headerStyle !== undefined ? { headerStyle: out.headerStyle } : {}),
    ...(out.summaryRows.length > 0 ? { summaryRows: out.summaryRows } : {}),
  };

  // ---- the layout, from output headers to ids ----
  let sort = rules.transform.sort;
  const sortIds = format.layout.sort.map((k) => idOf.get(k.header));
  if (sortIds.every((id) => id !== undefined)) {
    sort = format.layout.sort.map((k, i) => ({ column: sortIds[i]!, dir: k.dir }));
    supplied.push('sort');
  } else unresolved.push('sort');

  const { group: _ownGroup, ...transformRest } = rules.transform;
  let transform: LearnResult['transform'] = transformRest;
  const g = format.layout.group;
  if (!g) {
    supplied.push('group', 'blankRows');
  } else {
    const by = idOf.get(g.by);
    if (by !== undefined) {
      transform = {
        ...transformRest,
        group: {
          by,
          showDetailRows: g.showDetailRows,
          ...(g.blankRowsAfter !== undefined ? { blankRowsAfter: g.blankRowsAfter } : {}),
          ...(g.summaryRows.length > 0 ? { summaryRows: g.summaryRows } : {}),
        },
      };
      supplied.push('group', 'blankRows');
    } else {
      transform = rules.transform;
      unresolved.push('group');
    }
  }

  // ---- the checks: the input side's own, the output side's the format's ----
  const validations = [...rules.validations.filter((v) => (v.on ?? 'input') !== 'output'), ...format.outputValidations];

  return {
    rules: { ...rules, output, transform: { ...transform, sort }, validations },
    unresolved,
    supplied: supplied.filter((p) => !unresolved.includes(p)),
  };
}
