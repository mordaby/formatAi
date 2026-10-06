// What is asked at Save, and only there (owner decision 2026-10-06, "fewer clicks"; SPEC amendments "a list copied from the example is asked at
// Save" and v15 "what a saved format may keep", docs/proposals/saved-format-contents.md section 6). Nothing asks while learning or converting:
// the rules are used as they are for the conversion and the download, and nothing is stored on the server until Save. At Save, ONE popup with a
// line per finding in the rules about to be stored - and only what the server does not hold yet:
//   - a list of fixed values (`CopiedListQuestion`, engine `copiedLists`: a lookup, a value map or a chain of cases keyed on an input column,
//     not a small vocabulary), which the learn found in its kept answer and still is in the rules (`listsToConfirm`);
//   - an identifier-shaped value - an ID number, a phone, an email, a card or bank account number - anywhere in the rules (shared
//     `identifiersToConfirm`, run here on the rules as they will be sent: an edit that typed one is asked about too).
// "Save without them" takes them out (`withoutFindings`: each listed column needs your input, its values gone; a fix, a filter or a check that
// holds an identifier is removed).
// Pure; no engine code (types only: the main thread never loads the engine, see boundaries.test.ts).
import type { CopiedListQuestion, OneTimeQuestion } from '@formatai/engine';
import { hasCopiedList, identifiersToConfirm, withoutCopiedList, withoutIdentifiers, withoutUnreadLists, type IdentifierFinding } from '@formatai/shared';
import type { EditableRules } from './types';

/** One line of the Save popup: a list of fixed values, or an identifier-shaped value. */
export type SaveFinding = CopiedListQuestion | IdentifierFinding;

export const isListFinding = (f: SaveFinding): f is CopiedListQuestion => f.kind === 'copiedList';

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
 * Everything to ask about before `rules` are stored, in one popup: the lists (`listsToConfirm`), then the identifier-shaped values the rules
 * as sent would keep (`withoutUnreadLists`: a table nothing reads is never sent, so it is never asked about) and the server does not hold yet
 * (`stored`, the same way); in output order, a line on an input column (a fix, a filter, a check) last. Empty: the save goes at once.
 */
export function findingsToConfirm(rules: EditableRules, lists: readonly CopiedListQuestion[], stored?: EditableRules): SaveFinding[] {
  const identifiers = identifiersToConfirm(withoutUnreadLists(rules), stored ? withoutUnreadLists(stored) : undefined);
  const order = (f: SaveFinding): number => f.out ?? Number.MAX_SAFE_INTEGER;
  // (A stable sort: on one column, its list line comes before its identifier line.)
  return [...listsToConfirm(rules, lists, stored), ...identifiers].sort((a, b) => order(a) - order(b));
}

/**
 * "Save without them": the rules with every one of these lists taken out (shared `withoutCopiedList`): each column needs your input - left
 * empty, reported unsupported (`overfit`) - and its copied values are gone. A list the rules no longer hold is skipped.
 */
export function withoutCopiedLists<R extends EditableRules>(rules: R, lists: readonly CopiedListQuestion[]): R {
  return lists.reduce<R>((acc, q) => withoutCopiedList(acc, q.header, q.list) ?? acc, rules);
}

/** "Save without them" for the whole popup: its lists (`withoutCopiedLists`), then its identifier-shaped values (shared `withoutIdentifiers`). */
export function withoutFindings<R extends EditableRules>(rules: R, findings: readonly SaveFinding[]): R {
  const next = withoutCopiedLists(rules, findings.filter(isListFinding));
  const identifiers = findings.filter((f): f is IdentifierFinding => f.kind === 'identifier');
  return identifiers.length > 0 ? withoutIdentifiers(next, identifiers) : next;
}
