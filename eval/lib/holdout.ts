// The hold-out check (SPEC 10): "the runner checks that the rules learned from
// input/output also convert next.input into exactly next.output" - the real test of
// "would this still be right on next month's file" (LEARN_PROMPT's system prompt).
//
// DECISION: csv/txt outputs are byte-compared (the file IS the semantic content: any
// byte difference is a real difference the receiving system would see). xlsx outputs
// are compared by cell VALUE instead, read back through the same `readWorkbook` the
// product itself uses: a learned rules file may legitimately differ from
// `reference.rules.json` in purely cosmetic ways (e.g. a missing column `width`) that
// change the xlsx bytes without changing what a person or a downstream system reads
// from the file, and the hold-out check should judge correctness, not byte identity.
import { readWorkbook, convertFile } from '@formatai/engine';
import type { RawCell, RawSheet } from '@formatai/engine';
import type { LearnResult, Rules } from '@formatai/shared';
import type { CaseFile } from './caseLoader.js';

export interface HoldOutResult {
  ok: boolean;
  reason?: string;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function cellValue(c: RawCell | null | undefined): string | number | boolean | null {
  return c ? c.v : null;
}

function valuesEqual(a: string | number | boolean | null, b: string | number | boolean | null): boolean {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-9;
  return a === b;
}

/** Compares the first sheet of two workbooks cell-by-cell (values only - styles,
 * widths, bold and column order-as-bytes don't matter here). */
function sheetsEqualByValue(a: RawSheet | undefined, b: RawSheet | undefined): boolean {
  if (!a || !b) return false;
  const rowCount = Math.max(a.rows.length, b.rows.length);
  for (let r = 0; r < rowCount; r++) {
    const ar = a.rows[r] ?? [];
    const br = b.rows[r] ?? [];
    const colCount = Math.max(ar.length, br.length);
    for (let c = 0; c < colCount; c++) {
      if (!valuesEqual(cellValue(ar[c]), cellValue(br[c]))) return false;
    }
  }
  return true;
}

export async function checkHoldOut(rules: LearnResult | Rules, next: { input: CaseFile; output: CaseFile }): Promise<HoldOutResult> {
  const result = await convertFile(rules, next.input.bytes, next.input.fileName);
  if (!result.ok) return { ok: false, reason: `convertFile(next.input) failed: ${JSON.stringify(result.error)}` };

  const fileType = rules.output.file?.type ?? 'xlsx';
  if (fileType === 'csv' || fileType === 'txt') {
    return { ok: bytesEqual(result.bytes, next.output.bytes) };
  }

  const actualWb = await readWorkbook(result.bytes, next.output.fileName);
  const expectedWb = await readWorkbook(next.output.bytes, next.output.fileName);
  const ok = sheetsEqualByValue(actualWb.sheets[0], expectedWb.sheets[0]);
  return ok ? { ok: true } : { ok: false, reason: 'next.input -> rules does not match next.output (cell values differ)' };
}
