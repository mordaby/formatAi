// The rules map as data (SPEC 8.11): the UI renders this, it never reads the rules JSON
// itself. Pure types, no runtime code.
import type { LayoutProblemCode } from '@formatai/engine';
import type { Assumption, Unsupported } from '@formatai/shared';

export type RulesTextLang = 'he' | 'en';

export type SectionId = 'rows' | 'columns' | 'layout' | 'checks' | 'functions';

/** SPEC 8.11 "Line status": a check mark / amber / amber / pencil. */
export type LineStatus = 'matches' | 'check' | 'needsInput' | 'edited';

/**
 * One styled piece of a sentence. `line.text` is exactly the concatenation of every part's
 * `text`, so a caller that only wants a string can ignore `parts`.
 *
 * - `text`: plain words in the UI language (follows the page direction).
 * - `name`: a column, header, table or function name. Render it in `<bdi>` (SPEC 16.2).
 * - `value`: a literal: a quoted value, a number, a date format. Render it in `<bdi>`.
 * - `arrow`: the "target <- source" arrow, always written as a left arrow. Mirror it in RTL
 *   (SPEC 16.2 "Mirror directional icons"): `[dir=rtl] .arrow { transform: scaleX(-1) }`.
 * - `formula`: a calculation that has no plain-words form (e.g. `round(Cost × 1.18, 2)`).
 *   Render `parts` inside ONE `dir="ltr"` isolate, each `name`/`value` in its own `<bdi>`.
 */
export type SimplePart = { kind: 'text' | 'name' | 'value'; text: string };
export type Part =
  | SimplePart
  | { kind: 'arrow'; text: string }
  | { kind: 'formula'; text: string; parts: SimplePart[] };

export type TargetKind =
  | 'input' // sheet / header row / stop row (`header` is unused)
  | 'readAs' // one text an input column reads as another value (SPEC 8.4a): `index` into input.columns, `name` = the exact text
  | 'filter' // index into input.rowFilters
  | 'dedupe'
  | 'expand'
  | 'column' // index into output.columns, header = the output header
  | 'title' // index into output.titleRows
  | 'sort'
  | 'group' // transform.group (by, detail rows)
  | 'summaryGroup' // index into the (effective) group summary rows
  | 'summaryEnd' // index into the (effective) output summary rows
  | 'blankRows' // transform.group.blankRowsAfter
  | 'file' // output.file / sheet name / direction
  | 'validation' // index into validations
  | 'function' // name = the function's name
  | 'table'; // name = the table's name

/** What the editor opens when the line is clicked. */
export interface LineTarget {
  kind: TargetKind;
  index?: number;
  header?: string;
  name?: string;
}

export interface Line {
  /** Stable across re-renders and language changes: "col:Price", "filter:0", "dedupe", "summary:end:0". */
  id: string;
  /** The sentence, in the requested language. */
  text: string;
  /** The same sentence in styled pieces (always present). */
  parts: Part[];
  status: LineStatus;
  /** Plain words (from the shared message dictionary where one exists) explaining the status. */
  statusReason?: string;
  target: LineTarget;
}

export interface Section {
  id: SectionId;
  title: string;
  lines: Line[];
}

/** An assumption or unsupported entry that could not be tied to any line. */
export interface Note {
  kind: 'unsupported' | 'assumption';
  code: string;
  column?: string;
  message: string;
}

export interface RulesMapModel {
  /** Rows, Columns, Layout and Checks always; Functions only when the rules define any. */
  sections: Section[];
  notes: Note[];
}

/**
 * The part of `VerifyResult` (engine `verifyAgainstExample`) this module reads. Declared
 * structurally so the main thread never has to import the engine; a full `VerifyResult`
 * is assignable to it.
 */
export interface VerificationLike {
  matched: number;
  total: number;
  mismatches: readonly { exampleRow: number; column: string }[];
  /** What each layout difference is about (a code, never the English sentence). */
  layoutIssues: readonly { code: LayoutProblemCode }[];
}

export interface DescribeOptions {
  lang: RulesTextLang;
  verification?: VerificationLike | undefined;
  /** Replaces `rules.unsupported` when given (e.g. after the user resolved some). */
  unsupported?: readonly Unsupported[] | undefined;
  /** Replaces `rules.assumptions` when given (e.g. after the user pressed "Keep"). */
  assumptions?: readonly Assumption[] | undefined;
  /** Ids of lines the user changed; they show as "edited by you" whatever else is true. */
  edited?: ReadonlySet<string> | undefined;
}
