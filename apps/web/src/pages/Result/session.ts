// What the Result screen keeps for one learn result, outside the component: the editor (with its undo history) and
// the format's name. Leaving the screen (to read the privacy page, say) and coming back finds the edits where they
// were, and opening the sign-in wall never touches them (SPEC 5 E: "the learned rules survive sign-in").
import { EditorStore } from '../../editor';
import type { LearnOutput } from '../../worker/engineApi';

export interface ResultSession {
  store: EditorStore;
  /** The format's name (SPEC 8: defaults to the example output's file name; the user can rename it). */
  name: string;
}

const sessions = new WeakMap<LearnOutput, ResultSession>();

/** "Payments.xlsx" -> "Payments". */
export function defaultFormatName(fileName: string | undefined, fallback: string): string {
  if (!fileName) return fallback;
  const base = fileName.split(/[/\\]/).pop() ?? fileName;
  const dot = base.lastIndexOf('.');
  const stem = (dot > 0 ? base.slice(0, dot) : base).trim();
  return stem === '' ? fallback : stem;
}

export function getResultSession(result: LearnOutput, defaultName: string): ResultSession {
  let s = sessions.get(result);
  if (!s) {
    // The caller only shows the screen for a result with rules.
    s = { store: new EditorStore(result.rules!), name: defaultName };
    sessions.set(result, s);
  }
  return s;
}
