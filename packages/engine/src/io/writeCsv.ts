import type { OutputSheet } from '../types';
import { writeDelimited } from './writeDelimited';

/**
 * Writes an OutputSheet as UTF-8-with-BOM CSV, CRLF line endings, RFC-4180
 * minimal quoting, comma delimiter. Kept as a thin convenience wrapper: the
 * real implementation (and the txt/quote/encoding variants) lives in
 * writeDelimited.ts.
 */
export function writeCsv(sheet: OutputSheet): Uint8Array {
  return writeDelimited(sheet, { type: 'csv' });
}
