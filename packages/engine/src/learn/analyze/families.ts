// Families (SPEC 6.2 step 3): several output rows from one input row. Each
// pattern is tested on EVERY family: columns to rows, split cell, fixed
// fan-out; anything else is row expansion (unsupported, SPEC 6.3).

import { limits } from '@formatai/shared';
import type { RawCell } from '../../types';
import { EMPTY, TEXT, columnFromCells, norms, normFast, type ColumnData } from './cells';
import { eqTyped } from './relations';
import type { AlignedRow, CreatedKind, Family } from './types';

export interface CreatedData {
  kind: CreatedKind;
  /** Values per aligned row. */
  col: ColumnData;
}

export type FamilyFinding =
  | { kind: 'plain'; families: Family[] }
  | {
      kind: 'columnsToRows';
      families: Family[];
      in: number[];
      labelOut: number;
      valueOut: number;
      skipEmpty: boolean;
      created: CreatedData[];
      /** Input rows that produce no row because every listed cell is empty. */
      explainsDrop: (r: number) => boolean;
    }
  | {
      kind: 'splitCell';
      families: Family[];
      in: number;
      separator: string;
      out: number;
      created: CreatedData[];
      explainsDrop: (r: number) => boolean;
    }
  | { kind: 'fixedFanOut'; families: Family[]; size: number; created: CreatedData[] }
  | { kind: 'rowExpansion'; families: Family[]; sizes: [number, number] };

/** Families in order of their first output row; `position[k]` = place of aligned row k in its family. */
export function groupFamilies(rows: AlignedRow[]): { families: Family[]; position: Int32Array } {
  const byIn = new Map<number, Family>();
  const families: Family[] = [];
  const position = new Int32Array(rows.length);
  rows.forEach((row, k) => {
    let f = byIn.get(row.in);
    if (!f) {
      f = { in: row.in, rows: [] };
      byIn.set(row.in, f);
      families.push(f);
    }
    position[k] = f.rows.length;
    f.rows.push(k);
  });
  return { families, position };
}

/** A column that takes, for aligned row k, input column colOf[k] at input row rowOf[k]. */
function pickColumn(inCols: ColumnData[], colOf: ArrayLike<number>, rowOf: ArrayLike<number>): ColumnData {
  const n = colOf.length;
  const kind = new Uint8Array(n);
  const text: string[] = new Array(n);
  const numKey: (string | null)[] = new Array(n);
  const num = new Float64Array(n);
  const date = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const src = inCols[colOf[k]!]!;
    const r = rowOf[k]!;
    kind[k] = src.kind[r]!;
    text[k] = src.text[r]!;
    numKey[k] = src.numKey[r]!;
    num[k] = src.num[r]!;
    date[k] = src.date[r]!;
  }
  return { n, kind, text, numKey, num, date, textDate: null };
}

function cellsOf(values: (string | number)[]): ColumnData {
  return columnFromCells(
    values.map((v): RawCell => ({ v })),
    false,
  );
}

const SPLIT_SEPARATORS = [';', ',', '/', '|', '\n'];

function splitParts(s: string, sep: string): string[] {
  return (sep === '\n' ? s.split(/\r?\n/) : s.split(sep)).map((p) => p.trim()).filter((p) => p !== '');
}

function cellText(col: ColumnData, r: number): string {
  return col.kind[r] === EMPTY ? '' : col.text[r]!;
}

export function detectFamilies(rows: AlignedRow[], inCols: ColumnData[], inHeaders: string[], outA: ColumnData[]): FamilyFinding {
  const { families, position } = groupFamilies(rows);
  let min = Infinity;
  let max = 0;
  for (const f of families) {
    min = Math.min(min, f.rows.length);
    max = Math.max(max, f.rows.length);
  }
  if (max <= 1) return { kind: 'plain', families };
  const K = rows.length;
  const rowOf = rows.map((r) => r.in);

  // ---- columns to rows: an output column's values are input headers ----
  const headerMap = new Map<string, number>();
  inHeaders.forEach((h, c) => {
    const n = normFast(h).toLowerCase();
    if (n !== '' && !headerMap.has(n)) headerMap.set(n, c);
  });
  for (let L = 0; L < outA.length; L++) {
    const label = outA[L]!;
    const nm = norms(label);
    const srcCol = new Int32Array(K);
    let ok = true;
    for (let k = 0; k < K && ok; k++) {
      const c = label.kind[k] === EMPTY ? undefined : headerMap.get(nm[k]!);
      if (c === undefined) ok = false;
      else srcCol[k] = c;
    }
    if (!ok) continue;
    const listed = [...new Set(srcCol)].sort((a, b) => a - b);
    if (listed.length < 2) continue;
    const value = pickColumn(inCols, srcCol, rowOf);
    let valueOut = -1;
    let bestRate = 0;
    for (let o = 0; o < outA.length; o++) {
      if (o === L) continue;
      let eq = 0;
      for (let k = 0; k < K; k++) if (eqTyped(value, outA[o]!, k)) eq++;
      if (eq / K > bestRate) {
        bestRate = eq / K;
        valueOut = o;
      }
    }
    if (bestRate < limits.analysis.families.minValueShare) continue;
    for (const skipEmpty of [true, false]) {
      const pass = families.every((f) => {
        const labels = f.rows.map((k) => srcCol[k]!).sort((a, b) => a - b);
        const expected = listed.filter((c) => !skipEmpty || inCols[c]!.kind[f.in] !== EMPTY);
        return labels.length === expected.length && labels.every((c, i) => c === expected[i]);
      });
      if (!pass) continue;
      const labelCol = cellsOf(Array.from(srcCol, (c) => inHeaders[c] ?? ''));
      return {
        kind: 'columnsToRows',
        families,
        in: listed,
        labelOut: L,
        valueOut,
        skipEmpty,
        created: [
          { kind: 'label', col: labelCol },
          { kind: 'value', col: value },
        ],
        explainsDrop: (r) => skipEmpty && listed.every((c) => inCols[c]!.kind[r] === EMPTY),
      };
    }
  }

  // ---- split cell: family size = number of parts of one input cell ----
  for (let c = 0; c < inCols.length; c++) {
    const col = inCols[c]!;
    let hasText = false;
    for (let r = 0; r < col.n && !hasText; r++) if (col.kind[r] === TEXT) hasText = true;
    if (!hasText) continue;
    for (const sep of SPLIT_SEPARATORS) {
      const partsOf = new Map<number, string[]>();
      const ok = families.every((f) => {
        const parts = splitParts(cellText(col, f.in), sep);
        partsOf.set(f.in, parts);
        return parts.length === f.rows.length;
      });
      if (!ok) continue;
      for (let P = 0; P < outA.length; P++) {
        const out = outA[P]!;
        let all = true;
        for (let k = 0; k < K && all; k++) {
          const part = partsOf.get(rowOf[k]!)![position[k]!];
          if (out.kind[k] === EMPTY || out.text[k]!.trim() !== part) all = false;
        }
        if (!all) continue;
        const parts: string[] = [];
        const index: number[] = [];
        const count: number[] = [];
        for (let k = 0; k < K; k++) {
          const ps = partsOf.get(rowOf[k]!)!;
          parts.push(ps[position[k]!]!);
          index.push(position[k]! + 1);
          count.push(ps.length);
        }
        return {
          kind: 'splitCell',
          families,
          in: c,
          separator: sep,
          out: P,
          created: [
            { kind: 'part', col: cellsOf(parts) },
            { kind: 'position', col: cellsOf(index) },
            { kind: 'count', col: cellsOf(count) },
          ],
          explainsDrop: (r) => splitParts(cellText(col, r), sep).length === 0,
        };
      }
    }
  }

  // ---- fixed fan-out: every family has the same size (2 up to `fixedFanOutMaxSize`, 5) ----
  if (min === max && max >= 2 && max <= limits.analysis.families.fixedFanOutMaxSize) {
    const index: number[] = [];
    for (let k = 0; k < K; k++) index.push(position[k]! + 1);
    return { kind: 'fixedFanOut', families, size: max, created: [{ kind: 'position', col: cellsOf(index) }] };
  }

  return { kind: 'rowExpansion', families, sizes: [min, max] };
}
