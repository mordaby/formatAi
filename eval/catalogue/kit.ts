// The catalogue's plumbing: from a `CatalogueType` to files (input, expected output), to the reference rules
// (assembled from the type's columns + its `RuleSpec`), and the comparison of two workbooks. No measurement here -
// that is measure.ts.
import {
  convertFile,
  formatYmd,
  formulaRulesFromWire,
  readWorkbook,
  toExcelDateFormat,
  typeCheck,
  checkLimits,
  type FormulaComputed,
  type FormulaWireResult,
} from '@formatai/engine';
import { checkRules, RulesSchema, type LearnResult, type Rules } from '@formatai/shared';
import { dateCell, writeFixture, type Cell, type RowSpec } from '../cases/lib/fixtures';
import { makeRng } from '../cases/lib/prng';
import { isYmd } from './data';
import type { CatalogueType, ExpectedTable, OutCol, Row, V } from './types';

export interface FileArtifact {
  /** File name with extension, e.g. "input.xlsx". */
  name: string;
  bytes: Uint8Array;
}

// ---------- Generation ----------

/** The seeded RNG of one (type, seed, variant). `variant` 'next' is the "next month" file: same generator, other data. */
export function rngFor(type: CatalogueType, seed: number, variant: 'example' | 'next') {
  return makeRng(`catalogue:${type.id}#${seed}${variant === 'next' ? '-next' : ''}`);
}

/** How many rows a generated file has: 22-36, from the same RNG (so it is part of the deterministic data). */
export function rowCountFor(rng: () => number): number {
  return 22 + Math.floor(rng() * 15);
}

export function generateRows(type: CatalogueType, seed: number, variant: 'example' | 'next'): Row[] {
  const rng = rngFor(type, seed, variant);
  const n = rowCountFor(rng);
  return type.generate({ rng, n, lang: type.lang, variant });
}

// ---------- Expected output ----------

function emptyToNull(v: V): V {
  return v === '' ? null : v;
}

/** The expected output of `type` for `rows`, computed by the oracle only (no engine involved). */
export function expectedTable(type: CatalogueType, rows: Row[]): ExpectedTable {
  if (type.table) return type.table(rows);
  const rs = type.reshape ? type.reshape(rows) : rows;
  let out: V[][] = rs.map((row, i) => type.outputs.map((o) => emptyToNull(oracleValue(o, row, i, rs))));
  if (type.finalize) out = type.finalize(out, rs);
  return { headers: type.outputs.map((o) => o.header), rows: out };
}

function oracleValue(o: OutCol, row: Row, i: number, all: readonly Row[]): V {
  if (o.value) return o.value(row, i, all);
  if (o.from !== undefined) return row[o.from] ?? null;
  throw new Error(`output column "${o.header}": neither \`from\` nor \`value\``);
}

// ---------- Files ----------

function inputCell(type: CatalogueType, colIndex: number, v: V): Cell {
  const col = type.input[colIndex]!;
  if (v === null) return null;
  if (isYmd(v)) {
    const as = col.dateAs ?? 'excel';
    if (as === 'excel') return dateCell(v.y, v.m, v.d, 'dd/mm/yyyy');
    return formatYmd(v, as, type.lang);
  }
  if (typeof v === 'number' && col.format !== undefined) return { v, z: col.format };
  return v;
}

export async function inputFile(type: CatalogueType, rows: Row[]): Promise<FileArtifact> {
  const header: RowSpec = { cells: type.input.map((c) => c.header) };
  const body: RowSpec[] = rows.map((row) => ({ cells: type.input.map((c, ci) => inputCell(type, ci, row[c.id] ?? null)) }));
  const bytes = await writeFixture({ name: 'Data', direction: type.lang === 'he' ? 'rtl' : 'ltr', language: type.lang, rows: [header, ...body] });
  return { name: 'input.xlsx', bytes };
}

function outputCell(type: CatalogueType, format: string | undefined, v: V): Cell {
  if (v === null) return null;
  if (isYmd(v)) return dateCell(v.y, v.m, v.d, toExcelDateFormat(format ?? 'DD/MM/YYYY', type.lang));
  if (typeof v === 'number' && format !== undefined) return { v, z: format };
  return v;
}

export async function outputFile(type: CatalogueType, table: ExpectedTable, rows: readonly Row[] = []): Promise<FileArtifact> {
  const file = type.outFile ?? { type: 'xlsx' as const };
  const formats = table.headers.map((_, ci) => type.outputs[ci]?.format);
  const body: RowSpec[] = table.rows.map((row) => ({ cells: row.map((v, ci) => outputCell(type, formats[ci], v)) }));
  const titles: RowSpec[] = (type.titles?.(rows) ?? []).map((t) => ({ cells: [t, ...table.headers.slice(1).map(() => null)] }));
  const rowsSpec: RowSpec[] = file.header === false ? body : [...titles, { cells: table.headers }, ...body];
  const bytes = await writeFixture({ name: 'Report', direction: type.lang === 'he' ? 'rtl' : 'ltr', language: type.lang, file, rows: rowsSpec });
  return { name: `output.${file.type}`, bytes };
}

// ---------- Reference rules ----------

/** The reference rules of an expressible type, in the AI step's wire shape (formula TEXT in every expression position). */
export function assembleWire(type: CatalogueType): FormulaWireResult<LearnResult> {
  const spec = type.rule;
  if (spec === null) throw new Error(`${type.id}: not expressible (rule is null)`);
  const idOf = (o: OutCol, i: number): string => o.id ?? `c${i + 1}`;

  const computed: FormulaComputed[] = [];
  const outputColumns: LearnResult['output']['columns'] = [];
  type.outputs.forEach((o, i) => {
    let from: string;
    if (o.formula !== undefined) {
      from = idOf(o, i);
      computed.push({ id: from, type: o.type ?? 'text', expr: o.formula });
    } else if (o.from !== undefined) from = o.from;
    else throw new Error(`${type.id}: output column "${o.header}" has neither \`from\` nor \`formula\` - the reference rule cannot produce it`);
    outputColumns.push({ header: o.header, from, ...(o.format !== undefined ? { format: o.format } : {}), ...(o.agg !== undefined ? { agg: o.agg } : {}) });
  });

  const transform = spec.transform ?? {};
  return {
    schemaVersion: 1,
    input: {
      sheet: { pick: 'first' },
      headerRow: 'auto',
      columns: type.input.map((c) => ({
        id: c.id,
        header: c.header,
        type: c.type,
        ...(c.padLeft !== undefined ? { padLeft: c.padLeft } : {}),
        ...(c.inputFormats !== undefined ? { inputFormats: c.inputFormats } : c.dateAs !== undefined && c.dateAs !== 'excel' ? { inputFormats: [c.dateAs] } : {}),
      })),
      ...(spec.input?.rowFilters ? { rowFilters: spec.input.rowFilters } : {}),
    },
    transform: { ...transform, computed: [...(transform.computed ?? []), ...computed], valueMaps: transform.valueMaps ?? [], sort: transform.sort ?? [] },
    output: {
      ...(type.outFile ? { file: type.outFile } : {}),
      sheetName: 'Output',
      direction: type.lang === 'he' ? 'rtl' : 'ltr',
      language: type.lang,
      titleRows: (spec.output?.titleRows ?? []) as LearnResult['output']['titleRows'],
      columns: outputColumns,
      ...(spec.output?.summaryRows ? { summaryRows: spec.output.summaryRows as NonNullable<LearnResult['output']['summaryRows']> } : {}),
    },
    validations: spec.validations ?? [],
    unsupported: [],
    assumptions: [],
  };
}

export interface ParsedRules {
  ok: boolean;
  rules?: Rules;
  /** Every problem found, as "<stage>: <message>". */
  problems: string[];
}

/** The language-side validity of a reference rule: formula text parses, RulesSchema accepts it, checkRules, typeCheck and the paid-tier limits find nothing. */
export function parseRules(type: CatalogueType): ParsedRules {
  const problems: string[] = [];
  let wire: FormulaWireResult<LearnResult>;
  try {
    wire = assembleWire(type);
  } catch (e) {
    return { ok: false, problems: [`assemble: ${(e as Error).message}`] };
  }
  const { rules: parsed, problems: formulaProblems } = formulaRulesFromWire(wire);
  for (const p of formulaProblems) if (p.kind === 'formula') problems.push(`formula ${p.path}: ${p.message}`);
  if (problems.length > 0) return { ok: false, problems };

  const candidate = { ...(parsed as Record<string, unknown>), name: type.title, meta: { source: 'examplePair', status: 'verified' } };
  const schema = RulesSchema.safeParse(candidate);
  if (!schema.success) {
    for (const issue of schema.error.issues.slice(0, 5)) problems.push(`schema ${issue.path.join('.')}: ${issue.message}`);
    return { ok: false, problems };
  }
  const rules = schema.data as Rules;
  for (const p of checkRules(rules)) problems.push(`checkRules ${p.path}: ${p.message}`);
  for (const p of typeCheck(rules)) problems.push(`typeCheck ${p.path}: ${p.message}`);
  for (const p of checkLimits(rules, 'paid')) problems.push(`limits: ${JSON.stringify(p)}`);
  return { ok: problems.length === 0, rules, problems };
}

/** Runs the reference rules on an input file; the resulting bytes, or the error. */
export async function convertWith(rules: Rules | LearnResult, input: FileArtifact): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; error: string }> {
  const result = await convertFile(rules, input.bytes, input.name);
  if (!result.ok) return { ok: false, error: JSON.stringify(result.error) };
  return { ok: true, bytes: result.bytes };
}

// ---------- Comparing two workbooks (first sheet, by cell value) ----------

function cellKey(v: string | number | boolean | null | undefined): string | number | boolean | null {
  if (v === undefined || v === '') return null;
  return v;
}

function show(v: string | number | boolean | null): string {
  return v === null ? '(empty)' : JSON.stringify(v);
}

/** The first difference between two files' first sheets (values only: formats, widths and styles don't count), or null when equal. */
export async function firstDifference(actual: FileArtifact, expected: FileArtifact): Promise<string | null> {
  const a = (await readWorkbook(actual.bytes, actual.name)).sheets[0];
  const e = (await readWorkbook(expected.bytes, expected.name)).sheets[0];
  if (!a || !e) return 'a file has no sheet';
  const rowCount = Math.max(a.rows.length, e.rows.length);
  const header = e.rows[0] ?? [];
  for (let r = 0; r < rowCount; r++) {
    const ar = a.rows[r] ?? [];
    const er = e.rows[r] ?? [];
    const colCount = Math.max(ar.length, er.length);
    for (let c = 0; c < colCount; c++) {
      const av = cellKey(ar[c]?.v);
      const ev = cellKey(er[c]?.v);
      const same = typeof av === 'number' && typeof ev === 'number' ? Math.abs(av - ev) < 1e-9 : av === ev;
      if (!same) {
        const name = cellKey(header[c]?.v);
        return `row ${r + 1}, column ${c + 1}${name !== null ? ` "${String(name)}"` : ''}: expected ${show(ev)}, got ${show(av)}`;
      }
    }
  }
  return null;
}
