// Answering "a one-time change, or a rule we missed?" (SPEC 8.11, 21 v12 item 20; owner decision 2026-10-05). The engine finds, after an AI
// learn, the parts of the rules that explain exactly one row of the example, singled out by its ID, an exact amount or date, or its position
// (`OneTimeQuestion`, `learn/oneTimers.ts`). The Result screen asks about each on its column's line; the three answers are edits of the rules
// on screen, whatever state they are in (the part is found by its content, `withoutRulePart`):
//   - one-time: the part goes (and the check, if "Not sure" had put it in), so the column's remaining rule applies to every row; the row
//     becomes a one-time cell of the session (not compared in that column, listed as a row that doesn't follow the rule) - one undo step;
//   - a rule: the part stays (a check "Not sure" put in goes); when there is no check this changes nothing, so it adds no undo step and the
//     question is closed for this screen only (`settled`, like the day/month order's answer that keeps the rules);
//   - not sure: the part stays, and the question's check (`sameAs`, `oneTime`) goes in, so a later row the part applies to is flagged. The
//     check is the answer's marker: while it is in the rules the question is folded ("Not sure yet ..."), undo or deleting it opens it again.
//
// The second kind (owner amendment, 2026-10-06), `kind: 'copiedList'`: the column's value comes from a list keyed on a column that is
// different on every row of the example ("Account Manager: is this the rule?"). Two answers, the same mechanism:
//   - "a one-time edit" (`answerOneTime`): the column's list goes (`withoutCopiedList`): the column needs your input and is left empty - one
//     undo step, no one-time cell (the column is not compared at all);
//   - "that's the rule" (`answerRule`): nothing changes, the question closes for this screen (`settled`).
// It has no "Not sure" (no check says it), and is open while the column still takes its value from the list (`hasCopiedList`).
// Pure; no engine code (types only: the main thread never loads the engine, see boundaries.test.ts).
import type { OneTimeQuestion } from '@formatai/engine';
import { canonicalJson, hasCopiedList, hasRulePart, withoutCopiedList, withoutRulePart, type Validation } from '@formatai/shared';
import type { EditableRules, OneTimeCell } from './types';

/** The question's key on screen (one column may ask about several rows, and once about its list). */
export const oneTimeKey = (q: OneTimeQuestion): string => (q.kind === 'copiedList' ? `${q.header}\u0000list` : `${q.header}\u0000${q.row}`);

/** Whether a validation is the check "Not sure" put in for this question (a copied-list question has none). */
export function isOneTimeCheck(v: Validation, q: OneTimeQuestion): boolean {
  return q.kind !== 'copiedList' && q.check !== null && canonicalJson(v) === canonicalJson(q.check);
}

/**
 * Where the question stands for these rules: `closed` when the part is not there any more (it was taken out, or the column was changed or left
 * empty) or the user said it is a rule (`settled`); `unsure` while the check "Not sure" put in is in the rules; else `open`. A copied-list
 * question is open while the column takes its value from the list and no answer was given, else closed.
 */
export function oneTimeState(rules: EditableRules, q: OneTimeQuestion, settled: boolean): 'open' | 'unsure' | 'closed' {
  if (q.kind === 'copiedList') return !settled && hasCopiedList(rules, q.header, q.list) ? 'open' : 'closed';
  const column = rules.output.columns.find((c) => c.header === q.header);
  if (!column || column.from === null || !hasRulePart(rules, q.part)) return 'closed';
  if (rules.validations.some((v) => isOneTimeCheck(v, q))) return 'unsure';
  return settled ? 'closed' : 'open';
}

const withoutCheck = <R extends EditableRules>(rules: R, q: OneTimeQuestion): R =>
  rules.validations.some((v) => isOneTimeCheck(v, q)) ? ({ ...rules, validations: rules.validations.filter((v) => !isOneTimeCheck(v, q)) } as R) : rules;

/**
 * "A one-time change": the rules without the part (and without the question's check), and the session's one-time cells with its row. A
 * copied list: the rules without the column's list (it needs your input), the cells as they are. Null: the part (the list) is not there.
 */
export function answerOneTime<R extends EditableRules>(rules: R, q: OneTimeQuestion, cells: readonly OneTimeCell[]): { rules: R; oneTime: OneTimeCell[] } | null {
  if (q.kind === 'copiedList') {
    const without = withoutCopiedList(rules, q.header, q.list);
    return without ? { rules: without, oneTime: [...cells] } : null;
  }
  const without = withoutRulePart(rules, q.part);
  if (!without) return null;
  return { rules: withoutCheck(without, q), oneTime: [...cells, { exampleRow: q.row, column: q.header }] };
}

/** "A rule": the rules as they are, without the question's check. */
export function answerRule<R extends EditableRules>(rules: R, q: OneTimeQuestion): R {
  return withoutCheck(rules, q);
}

/** "Not sure": the rules with the question's check (null when the question has none - a copied list never has one: nothing to add). */
export function answerUnsure<R extends EditableRules>(rules: R, q: OneTimeQuestion): R | null {
  if (q.kind === 'copiedList' || q.check === null) return null;
  if (rules.validations.some((v) => isOneTimeCheck(v, q))) return rules;
  return { ...rules, validations: [...rules.validations, q.check] } as R;
}
