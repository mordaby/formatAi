import type { LearnResult, Rules } from '@formatai/shared';
import { readWorkbook } from './io/read';
import { extractTable } from './io/extractTable';
import { writeCsv } from './io/writeCsv';
import { writeXlsx } from './io/writeXlsx';
import { runRules } from './pipeline';
import type { RunResult, TableDetection } from './types';

export interface ConvertOptions {
  outputType: 'xlsx' | 'csv';
}

export type ConvertResult =
  | (Extract<RunResult, { ok: true }> & { bytes: Uint8Array; detection: TableDetection })
  | (Extract<RunResult, { ok: false }> & { detection?: TableDetection });

/** Read a file, apply rules and write the result (flows C/D). Pure apart from async I/O parsing. */
export async function convertFile(
  rules: LearnResult | Rules,
  data: Uint8Array | ArrayBuffer,
  fileName: string,
  opts: ConvertOptions,
): Promise<ConvertResult> {
  const wb = await readWorkbook(data, fileName);
  const extracted = extractTable(wb, rules.input);
  if (!extracted.ok) return { ok: false, error: extracted.error, detection: extracted.detection };
  const result = runRules(rules, extracted.table, { fileName });
  if (!result.ok) return { ...result, detection: extracted.detection };
  const bytes = opts.outputType === 'csv' ? writeCsv(result.sheet) : await writeXlsx(result.sheet);
  return { ...result, bytes, detection: extracted.detection };
}
