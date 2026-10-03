import type { LearnResult, Rules } from '@formatai/shared';
import { readWorkbook } from './io/read';
import { extractTable } from './io/extractTable';
import { writeOutput } from './io/writeOutput';
import { runRules } from './pipeline';
import type { OutputFileSpec, RowDecisions, RunResult, TableDetection } from './types';

export interface ConvertOptions {
  /**
   * Overrides the rules' own `output.file` (SPEC 8.13) for this conversion,
   * e.g. to force a csv/txt preview of a format that's normally xlsx. When
   * omitted, the file type/options written are exactly `result.sheet.file`
   * (absent -> xlsx, per writeOutput's own default).
   */
  file?: OutputFileSpec;
  /** SPEC 21 v5 item 5: the user's per-run decisions about flagged rows (see `RunRulesOptions.rowDecisions`). */
  rowDecisions?: RowDecisions;
}

export type ConvertResult =
  | (Extract<RunResult, { ok: true }> & { bytes: Uint8Array; detection: TableDetection })
  | (Extract<RunResult, { ok: false }> & { detection?: TableDetection });

/** Read a file, apply rules and write the result (flows C/D). Pure apart from async I/O parsing. */
export async function convertFile(
  rules: LearnResult | Rules,
  data: Uint8Array | ArrayBuffer,
  fileName: string,
  opts: ConvertOptions = {},
): Promise<ConvertResult> {
  const wb = await readWorkbook(data, fileName);
  const extracted = extractTable(wb, rules.input);
  if (!extracted.ok) return { ok: false, error: extracted.error, detection: extracted.detection };
  const result = runRules(rules, extracted.table, { fileName, ...(opts.rowDecisions !== undefined ? { rowDecisions: opts.rowDecisions } : {}) });
  if (!result.ok) return { ...result, detection: extracted.detection };
  const sheet = opts.file !== undefined ? { ...result.sheet, file: opts.file } : result.sheet;
  const bytes = await writeOutput(sheet);
  return { ...result, bytes, detection: extracted.detection };
}
