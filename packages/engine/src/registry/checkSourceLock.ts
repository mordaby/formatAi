// SPEC 8.15 "The source lock": "A conversion's `input` section must match its source: every input column it declares
// exists in the source with the same header, aliases, type and padLeft (a conversion may use a subset of the source's
// columns), and its sheet pick, header row, stopAt and input validations equal the source's. Code enforces it wherever
// the format lock runs (after a learn, on every editor save); a conversion that breaks it is rejected like a
// `formatMismatch`."
//
// Pure, like `checkFormatLock` (checkFormatLock.ts): it reuses `sourceOf` to read the rules the same way the stored
// source was built, then compares field by field.
//
// DECISIONS
//  - A SUBSET is allowed: the conversion may declare fewer columns than the source has (a master file feeds several
//    formats, each reading only the columns it needs). A column the conversion declares that the source lacks is a problem.
//  - The comparison is of what the conversion DECLARES: header (exact), aliases (as a set - their order changes nothing:
//    the engine tries them all), type, `padLeft`, and `inputFormats` (the date formats a column is read with; in order,
//    because the reader tries them in order). `inputFormats` IS part of the lock: it is how the file is read, and a
//    conversion that reads the same column with another date format reads another file.
//  - `required` is NOT locked: the spec doesn't list it, and one conversion may need a column another doesn't; the
//    source's `required` is derived (required by at least one conversion).
//  - Input validations are compared as a set (their order changes nothing), by header (see `sourceOf`).
//  - `opts.ignoreAliases` skips the alias comparison only: for a check made BEFORE a conversion is saved into an existing
//    source, where the server merges aliases into the source instead of refusing (saving = reuse, SPEC 8.15).
import type { LearnResult, Rules, SourceColumn, SourceLockProblem, SourceStructure, Validation } from '@formatai/shared';
import { deepEqual } from './deepEqual';
import { sourceOf } from './sourceOf';

export interface SourceLockOptions {
  /** Don't compare aliases (see the file header). */
  ignoreAliases?: boolean;
}

/** Validations compared as a set: stable key with sorted properties (values of `oneOf` keep their order: it is theirs). */
function validationKey(v: Validation): string {
  const o = v as unknown as Record<string, unknown>;
  return JSON.stringify(Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]])));
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().join('\u0000') === [...b].sort().join('\u0000');
}

/** Why the conversion's copy of one column isn't the source's: the empty list when it is. */
export function columnDifferences(own: SourceColumn, source: SourceColumn, opts: SourceLockOptions = {}): { field: 'aliases' | 'type' | 'padLeft' | 'inputFormats'; message: string }[] {
  const out: { field: 'aliases' | 'type' | 'padLeft' | 'inputFormats'; message: string }[] = [];
  if (!opts.ignoreAliases && !sameSet(own.aliases, source.aliases)) {
    out.push({ field: 'aliases', message: `column "${own.header}": aliases must equal the source's ${JSON.stringify(source.aliases)}, got ${JSON.stringify(own.aliases)}` });
  }
  if (own.type !== source.type) {
    out.push({ field: 'type', message: `column "${own.header}": type must equal the source's "${source.type}", got "${own.type}"` });
  }
  if (own.padLeft !== source.padLeft) {
    out.push({ field: 'padLeft', message: `column "${own.header}": padLeft must equal the source's ${JSON.stringify(source.padLeft)}, got ${JSON.stringify(own.padLeft)}` });
  }
  if (!deepEqual(own.inputFormats ?? [], source.inputFormats ?? [])) {
    out.push({ field: 'inputFormats', message: `column "${own.header}": date formats must equal the source's ${JSON.stringify(source.inputFormats ?? [])}, got ${JSON.stringify(own.inputFormats ?? [])}` });
  }
  return out;
}

/** The reading options and the input checks of `own` against `source` (SPEC 8.15). */
export function readingDifferences(own: SourceStructure, source: SourceStructure): SourceLockProblem[] {
  const problems: SourceLockProblem[] = [];
  if (!deepEqual(own.inputReading.sheet, source.inputReading.sheet)) {
    problems.push({ kind: 'sourceMismatch', path: 'input.sheet', message: `must equal the source's sheet ${JSON.stringify(source.inputReading.sheet)}, got ${JSON.stringify(own.inputReading.sheet)}` });
  }
  if (own.inputReading.headerRow !== source.inputReading.headerRow) {
    problems.push({ kind: 'sourceMismatch', path: 'input.headerRow', message: `must equal the source's headerRow ${JSON.stringify(source.inputReading.headerRow)}, got ${JSON.stringify(own.inputReading.headerRow)}` });
  }
  if (!deepEqual(own.inputReading.stopAt, source.inputReading.stopAt)) {
    problems.push({ kind: 'sourceMismatch', path: 'input.stopAt', message: "must equal the source's stopAt" });
  }
  const a = own.inputValidations.map(validationKey).sort();
  const b = source.inputValidations.map(validationKey).sort();
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    problems.push({ kind: 'sourceMismatch', path: 'validations', message: "input validations must equal the source's" });
  }
  return problems;
}

/**
 * Checks a conversion's rules against the source it belongs to (SPEC 8.15). Returns `sourceMismatch` problems, none when
 * the conversion honours the lock.
 */
export function checkSourceLock(rules: LearnResult | Rules, source: SourceStructure, opts: SourceLockOptions = {}): SourceLockProblem[] {
  const own = sourceOf(rules);
  const problems: SourceLockProblem[] = [];

  own.inputSignature.columns.forEach((column, i) => {
    const there = source.inputSignature.columns.find((c) => c.header === column.header);
    if (!there) {
      problems.push({ kind: 'sourceMismatch', path: `input.columns[${i}]`, message: `column "${column.header}" is not in the source` });
      return;
    }
    for (const d of columnDifferences(column, there, opts)) {
      problems.push({ kind: 'sourceMismatch', path: `input.columns[${i}].${d.field}`, message: d.message });
    }
  });

  problems.push(...readingDifferences(own, source));
  return problems;
}
