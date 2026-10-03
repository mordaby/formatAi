// Does an output look like a saved format (SPEC 5 A2)? "Same headers in the same order and the same file type" - the two things a
// person can see. Pure, so both the "this looks like your format X" offer (flow A) and the Add a source screen use it.

export type OutputFileType = 'xlsx' | 'csv' | 'txt';

/** What differs between an output and a format, in the words the screen will use. Column numbers are 1-based. */
export type OutputMismatch =
  | { kind: 'fileType'; expected: OutputFileType; actual: OutputFileType }
  | { kind: 'count'; expected: number; actual: number }
  | { kind: 'column'; n: number; expected: string; actual: string }
  | { kind: 'missing'; n: number; expected: string }
  | { kind: 'extra'; n: number; actual: string };

export interface OutputShape {
  headers: readonly string[];
  fileType: OutputFileType;
}

export interface FormatShape extends OutputShape {
  /** SPEC 8.13 `file.header: false`: the file has no header row, so only the number of columns can be compared. */
  headerless?: boolean;
}

const norm = (header: string): string => header.trim();

/** The differences (none = the output matches the format). */
export function compareOutput(format: FormatShape, output: OutputShape): OutputMismatch[] {
  const problems: OutputMismatch[] = [];
  if (format.fileType !== output.fileType) problems.push({ kind: 'fileType', expected: format.fileType, actual: output.fileType });
  if (format.headers.length !== output.headers.length) problems.push({ kind: 'count', expected: format.headers.length, actual: output.headers.length });
  if (format.headerless) return problems;
  const width = Math.max(format.headers.length, output.headers.length);
  for (let i = 0; i < width; i++) {
    const expected = format.headers[i];
    const actual = output.headers[i];
    if (expected !== undefined && actual !== undefined) {
      if (norm(expected) !== norm(actual)) problems.push({ kind: 'column', n: i + 1, expected, actual });
    } else if (expected !== undefined) problems.push({ kind: 'missing', n: i + 1, expected });
    else if (actual !== undefined) problems.push({ kind: 'extra', n: i + 1, actual });
  }
  return problems;
}

/** `xlsx` for anything that is not delimited text, as the engine writes it (SPEC 8.13). */
export function fileTypeOfName(name: string): OutputFileType {
  const lower = name.toLowerCase();
  if (lower.endsWith('.csv')) return 'csv';
  if (lower.endsWith('.txt')) return 'txt';
  return 'xlsx';
}
