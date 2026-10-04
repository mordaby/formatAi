// Competing readings of one output column (SPEC 6.5, 8.11, 21 v12 item 11; docs/proposals/learning-loop.md 7.2): the example fits more
// than one rule for the column, and only the user knows which one is meant. Where the free engine finds that a column holds one value
// on every row AND the input could write that value too (a branch code "00" that is also the first two digits of every employee number,
// a "03/2026" that is the month of the Date column too), it does not guess and does not leave the column to the AI step (the AI step sees
// the same rows): it returns the readings, each as a RULE FRAGMENT that is ready to apply, and the result screen asks the user once.
//
// Types only (the builders are in fastPath.ts, next to the rule builders they reuse).
//
// DECISION (the shape): a reading is `{ kind, columns, fragment }`. `kind` is `'constant'` or the kind of the relation the data reading comes
// from (`'copy'`, `'substr'`, `'split'`, `'dateFormat'`, ...); any other kind another detector adds is the same shape with a kind of its own
// (`{ kind: 'dayMonthOrder', columns: [date column], fragment }`: the day/month order of a text date column that no value settles). The
// screen never reads `kind` except to tell the constant (it names the value) from the rest: it says each reading in words by applying its
// fragment to the rules and describing the column (the rules map's own sentences), so a new kind needs no screen code.
// `AmbiguousColumn.default` is the reading the free engine builds until the user answers, and `check` the visible, deletable check that goes
// with an unanswered question (it flags a run-time row where the readings differ). A detector that cannot say what differs sets `check: null`.

import type { Computed, InputColumn, PayloadCell, Validation, ValueMap } from '@formatai/shared';

/**
 * How a reading of a text date column changes the format the rules read it with (the day/month order, SPEC 21 v12 item 16): every place the
 * rules read the input column `column` (a header, as in the file) with `from` - the column's `inputFormats`, and each `toDate` of a computed
 * column that reads it - reads it with `to` instead. In place and idempotent: rules that already read `to` are left as they are.
 */
export interface DateFormatChange {
  column: string;
  from: string;
  to: string;
}

/** What one reading adds to a rules file. The ids are local to the fragment; the header ties each input column to the rules' own. */
export interface RuleFragment {
  /** What the output column reads once the fragment is applied: a declared input column's id (a copy) or a computed column's id (one the rules already have, when the fragment adds none). */
  from: string;
  /** The input columns the fragment reads, declared as the free engine declares them (type, padding, date formats). */
  inputColumns: InputColumn[];
  /** Computed columns the fragment adds, in run order (they read the input columns above, or an earlier one). */
  computed: Computed[];
  /** Value maps the fragment adds (none of today's kinds uses one). */
  valueMaps: ValueMap[];
  /** The day/month order: the formats the rules' own date columns are read with, changed in place (a fragment that adds nothing else). */
  dateFormats?: DateFormatChange[];
}

export interface ColumnReading {
  /** `'constant'`, or the kind it comes from (`'copy'`, `'substr'`, `'dateFormat'`, ...), or a kind another detector adds. */
  kind: string;
  /** The headers of the example input's columns the reading is made from (what a sentence may name), in order. */
  columns: string[];
  fragment: RuleFragment;
}

/** One output column whose example fits several rules. */
export interface AmbiguousColumn {
  /** Position in the example output. */
  out: number;
  /** The output header. */
  header: string;
  /** At least two readings; the constant first when there is one. */
  readings: ColumnReading[];
  /** The index of the reading the free engine builds until the user answers (the data reading: next month's value follows the data). */
  defaultReading: number;
  /**
   * The check that goes with an unanswered question: it flags a run-time row where the readings differ. A validation as the rules
   * carry it (an output check), so it is visible and deletable in the rules editor; null when no check can say it.
   * An answer removes it (it is the question's marker: present = not answered). A question with `check: null` has no marker: it is open
   * while the rules still read the default reading (the day/month order: no kind of check says "this date reads both ways").
   */
  check: Validation | null;
  /** The value every row of the example holds (the constant reading's value; a check may name it). */
  value?: PayloadCell;
}

/** Whether a validation is the check of this question (the question is unanswered while it is in the rules). */
export function isReadingCheck(v: Validation, column: Pick<AmbiguousColumn, 'check'>): boolean {
  const c = column.check;
  if (c === null) return false;
  return JSON.stringify(sorted(v)) === JSON.stringify(sorted(c));
}

function sorted(v: object): object {
  return Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
