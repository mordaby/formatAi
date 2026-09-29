import type { OutputSheet } from '../types';
import { writeDelimited } from './writeDelimited';
import { writeXlsx } from './writeXlsx';

/**
 * Dispatches to the right writer based on `sheet.file` (SPEC 8.13). Absent
 * `file` (or `type: 'xlsx'`) writes xlsx; 'csv'/'txt' write delimited text.
 */
export async function writeOutput(sheet: OutputSheet): Promise<Uint8Array> {
  const file = sheet.file;
  if (!file || file.type === 'xlsx') {
    return writeXlsx(sheet);
  }
  return writeDelimited(sheet, file);
}
