// SPEC 8.15 "The source lock": "A conversion's `input` section must match its source: every input column it declares
// exists in the source with the same header, aliases, type and padLeft (a conversion may use a subset of the source's
// columns), and its sheet pick, header row and stopAt equal the source's. Input validations are compared per column, on the
// columns the conversion declares (21 v11 item 8) [...]. Code enforces it wherever the format lock runs (after a learn, on
// every editor save); a conversion that breaks it is rejected like a `formatMismatch`."
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
//  - Input validations are compared as a set (their order changes nothing), by header (see `sourceOf`), and PER COLUMN, on the
//    columns the conversion declares: see `compareInputChecks`.
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

export interface InputCheckComparison {
  /** What stops the conversion from fitting the source, as `sourceMismatch` problems (path `validations`); none when the checks agree. */
  problems: SourceLockProblem[];
  /** What a source the conversion is merged into gains: its `flag` checks on a shared column the source lacks, and its checks on a column only it reads. */
  additions: Validation[];
}

/**
 * The input checks of `own` against `source`, per column (SPEC 8.15 "The source lock"). Both are in the SOURCE's terms: a check's
 * `column` and a signature's `header` are source headers (`mergeForReuse` brings a conversion there before asking).
 *
 * DECISION: input checks belong to the source PER COLUMN, and a conversion is held only to the checks on the columns it declares.
 * The learn step adds a `required` check for every column a conversion reads that had no empty cell, so two formats learned from the
 * same file that read different columns carry different sets of checks; held to each other as a whole set they could never share a
 * source (the reason `required` itself is not locked: one conversion may need a column another doesn't). So:
 *  - a check on a column the conversion doesn't declare is ignored for it; one on a column only the conversion reads is not the
 *    source's yet (`additions`);
 *  - on a column BOTH have, a check only one side has is a mismatch when it is `block` (it leaves rows out, so it would change the
 *    other conversion's output) and fine when it is `flag` (it only marks rows, never changes an output): a source takes the union
 *    (`additions`), the way `required` accumulates;
 *  - a check on no column of the file (a computed column's, kept by id as written, see `sourceOf`) is tied to no source column, so
 *    those keep the whole-set comparison.
 */
export function compareInputChecks(own: SourceStructure, source: SourceStructure): InputCheckComparison {
  const ownColumns = new Set(own.inputSignature.columns.map((c) => c.header));
  const sourceColumns = new Set(source.inputSignature.columns.map((c) => c.header));
  const ownKeys = new Set(own.inputValidations.map(validationKey));
  const sourceKeys = new Set(source.inputValidations.map(validationKey));
  const problems: SourceLockProblem[] = [];
  const additions = new Map<string, Validation>();
  const mismatch = (message: string): void => void problems.push({ kind: 'sourceMismatch', path: 'validations', message });

  for (const v of own.inputValidations) {
    if (!ownColumns.has(v.column)) continue; // a computed column's: compared as a whole, below
    const key = validationKey(v);
    if (!sourceColumns.has(v.column)) additions.set(key, v);
    else if (!sourceKeys.has(key)) {
      if (v.severity === 'block') mismatch(`the "${v.rule}" check on "${v.column}" leaves rows out, and the source does not have it`);
      else additions.set(key, v);
    }
  }
  for (const v of source.inputValidations) {
    if (!sourceColumns.has(v.column) || !ownColumns.has(v.column)) continue;
    if (v.severity === 'block' && !ownKeys.has(validationKey(v))) mismatch(`the source's "${v.rule}" check on "${v.column}" leaves rows out, and the conversion does not have it`);
  }

  const a = own.inputValidations.filter((v) => !ownColumns.has(v.column)).map(validationKey).sort();
  const b = source.inputValidations.filter((v) => !sourceColumns.has(v.column)).map(validationKey).sort();
  if (JSON.stringify(a) !== JSON.stringify(b)) mismatch("input validations that are on no column of the file must equal the source's");
  return { problems, additions: [...additions.values()] };
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
  problems.push(...compareInputChecks(own, source).problems);
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
