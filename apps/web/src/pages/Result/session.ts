// What the Result screen keeps for one learn result, outside the component: the editor (with its undo history) and
// the format's name. Leaving the screen (to read the privacy page, say) and coming back finds the edits where they
// were, and opening the sign-in wall never touches them (SPEC 5 E: "the learned rules survive sign-in").
import { EditorStore, type EditableRules } from '../../editor';
import type { LearnOutput } from '../../worker/engineApi';

/** Where a learn was saved (SPEC 8.12): from then on the screen is the editor of that source, and its address is the source's own. */
export interface SavedSource {
  formatId: string;
  conversionId: string;
  /** The version last saved: the next save says it is based on this one. */
  version: number;
}

/** The address of a saved source's editor. */
export function sourcePath(source: Pick<SavedSource, 'formatId' | 'conversionId'>): string {
  return `/formats/${encodeURIComponent(source.formatId)}/sources/${encodeURIComponent(source.conversionId)}`;
}

export interface ResultSession {
  store: EditorStore;
  /** The format's name (SPEC 8: defaults to the example output's file name; the user can rename it). */
  name: string;
  /** Set once the learn has been saved as a format and its first source: saving again writes a new version of that source. */
  source?: SavedSource | undefined;
  /** The deep analysis with AI has been started for this result (by the user, or by Home's "Deep analysis with AI if needed"): it is never started by itself twice. */
  deepRun?: boolean | undefined;
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

/** The session of a result, if the Result screen has made one (it never creates one). */
export function peekResultSession(result: LearnOutput): ResultSession | undefined {
  return sessions.get(result);
}

/** What comes back after signing in (SPEC 5 E): the rules as edited so far, which lines were edited, the exceptions, the name. */
export interface ResultSeed {
  name: string;
  rules: EditableRules;
  edited: readonly string[];
  exceptions: number[];
}

/** Puts the edits of an earlier session back on top of a re-run of the local analysis. */
export function seedResultSession(result: LearnOutput, seed: ResultSeed): void {
  sessions.set(result, { store: new EditorStore(seed.rules, { exceptions: seed.exceptions, edited: seed.edited }), name: seed.name });
}
