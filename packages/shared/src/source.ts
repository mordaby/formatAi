// The Source type (SPEC 8.15, 13): one kind of incoming file the company receives or keeps - one supplier's price list, one
// insurer's report, a master file that is updated all the time but keeps its structure. Sources belong to the company
// like formats do, and are named by the user. A conversion is a link between a source and a format.
//
// STRUCTURE ONLY (SPEC 8.15): headers, aliases, types, shapes (`padLeft`, `inputFormats`, `readAs`), which columns are required,
// how the file is read (sheet, header row, stop rule) and the input checks. Never a value, a min/max or a sample
// read from the data cells - there is no field here that could hold one. (An input check such as `range` carries the
// bounds its author wrote into the rule, exactly as it does in the conversion's own rules file; they are part of the
// rule, not something read from data. DECISION, see `sourceOf`.)
//
// `SourceStructure` is to `Source` what `Format` (format.ts) is to a stored format: the part that is derived from a
// conversion's rules (`packages/engine/src/registry/sourceOf.ts`, pure) and held to them by the source lock
// (`checkSourceLock`, SPEC 8.15). The engine never needs the Source at run time: every rules file stays self-contained.
import { z } from 'zod';
import { limits } from './config/limits';
import {
  ColumnTypeSchema,
  HeaderRowSchema,
  InputSheetSelectorSchema,
  ReadAsSchema,
  StopAtSchema,
  ValidationSchema,
  type ColumnType,
  type HeaderRow,
  type InputSheetSelector,
  type StopAt,
  type Validation,
} from './rules/schema';

/** One column of a source's input signature: what a file must have to be "this source" (SPEC 8.15). */
export interface SourceColumn {
  /** The header as the source knows it. */
  header: string;
  /** Other names the sender has used for it (SPEC 5 C: a confirmed mapping is saved here, once, for every format). */
  aliases: string[];
  type: ColumnType;
  /** Required by at least one of the source's conversions (DECISION): a file without it can't be run by that one. */
  required: boolean;
  /** `input.columns[].padLeft`: a shape of the column (an id that lost its leading zeros). Part of the source lock. */
  padLeft?: number;
  /** `input.columns[].inputFormats` (date formats the column is read with). DECISION: part of the source lock. */
  inputFormats?: string[];
  /**
   * `input.columns[].readAs` (SPEC 8.4a, 8.15): a cell's exact text -> the text the column reads it as. DECISION: part of the source lock, like
   * `inputFormats` - it is how the file is read, and a conversion that read "N/A" differently would read another file. These are the rule's own
   * parameters, typed by the user on the Run screen (like an input check's bounds), not values code read from the data cells.
   */
  readAs?: Record<string, string>;
}

export interface SourceInputSignature {
  columns: SourceColumn[];
}

/** How the file is read (`rules.input`: sheet pick, header row, stop rule). Equal in every conversion of the source. */
export interface SourceInputReading {
  sheet: InputSheetSelector;
  headerRow: HeaderRow;
  stopAt?: StopAt;
}

/** The structural part of a source; what `sourceOf(rules)` returns and `checkSourceLock` compares against. */
export interface SourceStructure {
  inputSignature: SourceInputSignature;
  inputReading: SourceInputReading;
  /** Validations with `on` other than "output", with `column` written as the input column's HEADER when the column is a
   * declared input column (ids differ between conversions of the same source; headers don't). */
  inputValidations: Validation[];
}

/** An earlier version of a source (`SourceDoc.versions` holds the versions that were REPLACED). */
export interface SourceVersion {
  version: number;
  source: SourceStructure;
  editedBy?: string;
  at: string;
}

/** SPEC 8.15 / 13: a source. Ids are strings here; the database document (`apps/api/src/models.ts`) holds ObjectIds. */
export interface Source extends SourceStructure {
  id: string;
  ownerId: string;
  name: string;
  /** Starts at 1; every edit of the structure (SPEC 8.15 "Editing a source") makes the next one. */
  version: number;
  versions: SourceVersion[];
  createdAt: string;
}

/** The source lock's finding (SPEC 8.15), shaped like `FormatProblem`; travels in an API error's `problems`. */
export interface SourceLockProblem {
  kind: 'sourceMismatch';
  /** Dotted/bracketed path into the conversion's rules, e.g. "input.columns[1].type". */
  path: string;
  message: string;
}

// ---------- zod (a source edit's body is checked with these; the rules schema is not touched) ----------

export const SourceColumnSchema = z.strictObject({
  header: z.string().min(1),
  aliases: z.array(z.string().min(1)),
  type: ColumnTypeSchema,
  required: z.boolean(),
  // (API audit 2026-10-07: bounded like a rules file's input column, `limits.rules.maxPadLength`.)
  padLeft: z.number().int().positive().max(limits.rules.maxPadLength).optional(),
  inputFormats: z.array(z.string().min(1)).optional(),
  readAs: ReadAsSchema.optional(),
});

export const SourceInputSignatureSchema = z.strictObject({
  columns: z.array(SourceColumnSchema).min(1),
});

export const SourceInputReadingSchema = z.strictObject({
  sheet: InputSheetSelectorSchema,
  headerRow: HeaderRowSchema,
  stopAt: StopAtSchema.optional(),
});

/** The structural part of a source, as stored and as `sourceOf` produces it. */
export const SourceStructureSchema = z.strictObject({
  inputSignature: SourceInputSignatureSchema,
  inputReading: SourceInputReadingSchema,
  inputValidations: z.array(ValidationSchema),
});

/** A column in a source edit: `was` is the header it had before, when the edit renames it. */
export const SourceColumnEditSchema = SourceColumnSchema.extend({ was: z.string().min(1).optional() });

/** The body of PATCH /api/sources/:id (`UpdateSourceRequest`): a rename and/or an edit of the structure. `name` is checked by the route. */
export const UpdateSourceBodySchema = z.strictObject({
  name: z.string().optional(),
  inputSignature: z.strictObject({ columns: z.array(SourceColumnEditSchema).min(1) }).optional(),
  inputReading: SourceInputReadingSchema.optional(),
  inputValidations: z.array(ValidationSchema).optional(),
  baseVersion: z.number().int().min(1).optional(),
});

export const SourceVersionSchema = z.strictObject({
  version: z.number().int().min(1),
  source: SourceStructureSchema,
  editedBy: z.string().optional(),
  at: z.string(),
});

/** A whole source, as the domain sees it (ids as strings). */
export const SourceSchema = z.strictObject({
  id: z.string().min(1),
  ownerId: z.string().min(1),
  name: z.string().min(1),
  inputSignature: SourceInputSignatureSchema,
  inputReading: SourceInputReadingSchema,
  inputValidations: z.array(ValidationSchema),
  version: z.number().int().min(1),
  versions: z.array(SourceVersionSchema),
  createdAt: z.string(),
});
