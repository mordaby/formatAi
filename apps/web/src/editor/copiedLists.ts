// A list copied from the example, asked at Save only (owner decision 2026-10-06, "fewer clicks"; SPEC amendment "a list copied from the
// example is asked at Save"). The engine finds, after an AI learn, a column whose value comes from a list keyed on a column that is different
// on every row of the example (`CopiedListQuestion`, `copiedLists` in `learn/oneTimers.ts`). Nothing asks about it while learning or
// converting: the list is used as it is for the conversion and the download, and nothing is stored on the server until Save. At Save, the
// lists the rules about to be stored still hold - and the server does not hold yet - are asked about once (`listsToConfirm`); "Save without"
// takes them out (`withoutCopiedLists`).
// Pure; no engine code (types only: the main thread never loads the engine, see boundaries.test.ts).
import type { CopiedListQuestion, OneTimeQuestion } from '@formatai/engine';
import { hasCopiedList, withoutCopiedList } from '@formatai/shared';
import type { EditableRules } from './types';

/** The copied lists of a learn's questions (a completion's answer's first, then the learn's): one per column. */
export function copiedListsOf(...lists: (readonly OneTimeQuestion[] | undefined)[]): CopiedListQuestion[] {
  const all = lists.flatMap((l) => l ?? []).filter((q): q is CopiedListQuestion => q.kind === 'copiedList');
  return all.filter((q, i, a) => a.findIndex((x) => x.header === q.header) === i);
}

/**
 * The lists to ask about before `rules` are stored: those a column still takes its value from (`hasCopiedList`), in output order. `stored`:
 * the rules the server holds now (a later save of the same source) - a list they already hold was asked about by the save that stored it,
 * and is not asked again. Empty: the save goes at once.
 */
export function listsToConfirm(rules: EditableRules, lists: readonly CopiedListQuestion[], stored?: EditableRules): CopiedListQuestion[] {
  return lists.filter((q) => hasCopiedList(rules, q.header, q.list) && !(stored && hasCopiedList(stored, q.header, q.list))).sort((a, b) => a.out - b.out);
}

/**
 * "Save without them": the rules with every one of these lists taken out (shared `withoutCopiedList`): each column needs your input - left
 * empty, reported unsupported (`overfit`) - and its copied values are gone. A list the rules no longer hold is skipped.
 */
export function withoutCopiedLists<R extends EditableRules>(rules: R, lists: readonly CopiedListQuestion[]): R {
  return lists.reduce<R>((acc, q) => withoutCopiedList(acc, q.header, q.list) ?? acc, rules);
}
