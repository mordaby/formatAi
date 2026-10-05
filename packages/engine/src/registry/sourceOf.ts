// SPEC 8.15 "Sources": a pure function `sourceOf(rules)` that extracts the source side of a conversion - the structure of
// the incoming file the rules read - exactly as `formatOf(rules)` extracts the format side (formatOf.ts):
//
//   * `inputSignature.columns`: every input column the rules DECLARE (`input.columns`): header, aliases, type, `required`,
//     and the shapes `padLeft`, `inputFormats` and `readAs` (SPEC 8.4a: the user's own "this text is read as that", typed on the Run
//     screen - a rule parameter like an input check's bounds, not a value code read from the data). A rules file declares only the columns some rule reads, so this is a
//     subset of the source's columns (the source holds the union over its conversions, SPEC 8.15);
//   * `inputReading`: `input.sheet`, `input.headerRow`, `input.stopAt`;
//   * `inputValidations`: `validations` whose `on` is not "output" (the output ones belong to the format, SPEC 8.8).
//
// STRUCTURE ONLY. There is nothing in here that could hold a value read from the data: no profile, no min/max taken from
// cells, no sample. `input.rowFilters` are NOT part of a source: they say which rows a FORMAT wants from the file (and
// carry values, e.g. `status = "Active"`), so they stay in the conversion.
//
// DECISION: `inputValidations` carry `column` as the input column's HEADER, not its id (like `formatOf` turns sort/group ids
// into output headers). Ids are picked by whoever wrote a conversion ("amount" in one, "amt" in another), headers are what
// the file has; without this two conversions of one source could never carry "equal" validations. A validation whose column
// is not a declared input column (a computed one, say) keeps its id as written, and the lock will compare it as such.
//
// DECISION: a validation's `on: "input"` is dropped from the copy (absent = "input", SPEC 8.8), so `{ on: 'input' }` and no `on`
// compare equal.
//
// DECISION: the input checks are stored exactly as the rules carry them, bounds included (`range { min, max }`, `oneOf
// { values }`): they are the rule's own parameters, written by the user or by the learn step, not values read from the file;
// and the source lock has to compare them to be able to say "equal". Sources gain no value that the rules file didn't already have.
import type { LearnResult, Rules, SourceColumn, SourceInputReading, SourceStructure, Validation } from '@formatai/shared';
import { isCodeCheck } from '@formatai/shared';
import { normalizeText } from '../values/text';

/**
 * How a header is compared when matching a file to a source (SPEC 8.12): `normalizeText` and case-insensitive - the very
 * normalization of `mapHeaders` (`pipeline/v1/normalize.ts`), so the way a conversion's columns are
 * compared with its source's and the way a file is matched to one can never disagree.
 */
export function sourceHeaderKey(header: string): string {
  return normalizeText(header).toLowerCase();
}

/**
 * Where `header` is in a source's columns, found the way the engine reads a file (SPEC 8.2 step 1): exact header, then an
 * exact alias, then the normalized header or alias. -1 when no column has that name.
 */
export function findSourceColumn(columns: readonly Pick<SourceColumn, 'header' | 'aliases'>[], header: string): number {
  if (header === '') return -1;
  const exact = columns.findIndex((c) => c.header === header);
  if (exact >= 0) return exact;
  const byAlias = columns.findIndex((c) => c.aliases.includes(header));
  if (byAlias >= 0) return byAlias;
  const key = sourceHeaderKey(header);
  if (key === '') return -1;
  return columns.findIndex((c) => sourceHeaderKey(c.header) === key || c.aliases.some((a) => a !== '' && sourceHeaderKey(a) === key));
}

/** One validation as a source keeps it: `column` by header when it is a declared input column, `on: "input"` dropped. */
function normalizeValidation(v: Validation, idToHeader: ReadonlyMap<string, string>): Validation {
  const { on: _on, ...rest } = v;
  return { ...rest, column: idToHeader.get(v.column) ?? v.column } as Validation;
}

/** Extracts the source side of a conversion's rules (SPEC 8.15). Pure; never mutates `rules`. */
export function sourceOf(rules: LearnResult | Rules): SourceStructure {
  const idToHeader = new Map(rules.input.columns.map((c) => [c.id, c.header] as const));

  const columns: SourceColumn[] = rules.input.columns.map((c) => {
    const col: SourceColumn = {
      header: c.header,
      aliases: c.aliases ? [...c.aliases] : [],
      type: c.type,
      required: c.required === true,
    };
    if (c.padLeft !== undefined) col.padLeft = c.padLeft;
    if (c.inputFormats !== undefined && c.inputFormats.length > 0) col.inputFormats = [...c.inputFormats];
    if (c.readAs !== undefined && Object.keys(c.readAs).length > 0) col.readAs = { ...c.readAs };
    return col;
  });

  const reading: SourceInputReading = {
    sheet: { ...rules.input.sheet },
    headerRow: rules.input.headerRow,
  };
  if (rules.input.stopAt) reading.stopAt = { when: rules.input.stopAt.when, values: [...rules.input.stopAt.values] };

  return {
    inputSignature: { columns },
    inputReading: reading,
    inputValidations: rules.validations.filter(isSourceCheck).map((v) => normalizeValidation(v, idToHeader)),
  };
}

/**
 * Whether a validation belongs to the source (SPEC 8.15): an input check, except the checks only code writes (`cutoffRange`, `sameAs`,
 * SPEC 8.8).
 * DECISION: a cut-off check is about a constant of THIS conversion's rules (where its comparison draws the line), like a row filter, not
 * about the file: it stays in the conversion and never travels to the source or to another format that reads the same column. So does the
 * marker of an open question about one of this conversion's columns (`sameAs`).
 */
export function isSourceCheck(v: Validation): boolean {
  return (v.on ?? 'input') !== 'output' && !isCodeCheck(v);
}
