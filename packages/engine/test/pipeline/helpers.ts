import type {
  Expand,
  InputColumn,
  LearnResult,
  RowFilter,
  RulesOutput,
  RulesTransform,
  Validation,
} from '@formatai/shared';
import { expect } from 'vitest';
import { runRules } from '../../src/pipeline';
import type { Flag, InputTable, OutRow, OutputSheet, RawCell, RunResult, RunSummary } from '../../src/types';

export type CellInput = string | number | boolean | null | RawCell;

/** In-memory InputTable. Plain values become cells; rows are numbered from Excel row 2. */
export function table(headers: string[], rows: CellInput[][], opts: { firstRow?: number; date1904?: boolean } = {}): InputTable {
  const first = opts.firstRow ?? 2;
  return {
    sheetName: 'Sheet1',
    direction: 'rtl',
    headers,
    rows: rows.map((r) =>
      r.map((c) => (c === null ? null : typeof c === 'object' ? c : ({ v: c } as RawCell))),
    ),
    rowNumbers: rows.map((_, i) => first + i),
    ...(opts.date1904 ? { date1904: true } : {}),
  };
}

/** A date cell as xlsx delivers it: an Excel serial with isDate. */
export function dateCell(serial: number): RawCell {
  return { v: serial, isDate: true, z: 'dd/mm/yyyy' };
}

export interface RulesInit {
  columns: InputColumn[];
  rowFilters?: RowFilter[];
  transform?: Partial<RulesTransform>;
  expand?: Expand;
  output?: Partial<RulesOutput>;
  /** Output columns: ids (header = id) or full rules. Defaults to every input column. */
  out?: (string | RulesOutput['columns'][number])[];
  validations?: Validation[];
}

export function rules(init: RulesInit): LearnResult {
  const outCols = (init.out ?? init.columns.map((c) => c.id)).map((c) =>
    typeof c === 'string' ? { header: c, from: c } : c,
  );
  return {
    schemaVersion: 1,
    input: {
      sheet: { pick: 'first' },
      headerRow: 'auto',
      columns: init.columns,
      ...(init.rowFilters ? { rowFilters: init.rowFilters } : {}),
    },
    transform: {
      computed: [],
      valueMaps: [],
      sort: [],
      ...(init.expand ? { expand: init.expand } : {}),
      ...init.transform,
    },
    output: {
      sheetName: 'Out',
      direction: 'rtl',
      language: 'he',
      titleRows: [],
      columns: outCols,
      ...init.output,
    },
    validations: init.validations ?? [],
    unsupported: [],
    assumptions: [],
  };
}

export interface OkRun {
  sheet: OutputSheet;
  flags: Flag[];
  summary: RunSummary;
}

export function runOk(r: LearnResult, t: InputTable, opts?: { fileName?: string }): OkRun {
  const res: RunResult = runRules(r, t, opts);
  if (!res.ok) throw new Error(`run failed: ${JSON.stringify(res.error)}`);
  return res;
}

export function dataRows(sheet: OutputSheet): OutRow[] {
  return sheet.rows.filter((r) => r.kind === 'data');
}

/** The `v` of every data row's cells. */
export function values(sheet: OutputSheet): (string | number | boolean | null)[][] {
  return dataRows(sheet).map((r) => r.cells.map((c) => c.v));
}

/** Compact picture of the rows below the header: kind + values, for group/subtotal layouts. */
export function body(sheet: OutputSheet): [string, ...(string | number | boolean | null)[]][] {
  const start = sheet.rows.findIndex((r) => r.kind === 'header') + 1;
  return sheet.rows.slice(start).map((r) => [r.kind, ...r.cells.map((c) => c.v)]);
}

export function col(id: string, type: InputColumn['type'] = 'text', extra: Partial<InputColumn> = {}): InputColumn {
  return { id, header: id, type, ...extra };
}

export function expectOk(res: RunResult): asserts res is Extract<RunResult, { ok: true }> {
  expect(res.ok, res.ok ? '' : JSON.stringify(res.error)).toBe(true);
}
