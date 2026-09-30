// The editor as a small store (like `LearnFlow`): React-free and testable, with `useEditor` a thin wrapper.
// Wraps the pure model: each `apply` returns its result right away (ok or typed problems), so a form can
// show the problem next to the field that caused it.
import {
  applyEdit,
  canRedo,
  canUndo,
  createEditorState,
  markSaved,
  redo,
  resetEditor,
  undo,
  withFormat,
} from './model';
import type { ActionResult, EditableRules, EditAction, EditorOptions, EditorState, ExampleInputColumn, FormatInfo } from './types';

export interface ApplyActionOptions {
  /**
   * Edits with the same non-empty key, one after the other, are one undo step (typing in one field).
   * Any other edit, undo, redo or save ends the run.
   */
  coalesce?: string;
  /** The example input's columns: an edit that uses one no rule declares yet declares it in the same undoable step. */
  available?: readonly ExampleInputColumn[] | undefined;
}

export class EditorStore {
  private state: EditorState;
  private readonly listeners = new Set<() => void>();
  private coalesceKey: string | undefined;

  constructor(rules: EditableRules, options: EditorOptions = {}) {
    this.state = createEditorState(rules, options);
  }

  getState = (): EditorState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(next: EditorState): void {
    if (next === this.state) return;
    this.state = next;
    for (const l of this.listeners) l();
  }

  /** Applies one edit; problems leave the editor exactly as it was. */
  apply = (action: EditAction, options: ApplyActionOptions = {}): ActionResult => {
    const key = options.coalesce;
    const merge = key !== undefined && key !== '' && key === this.coalesceKey;
    const { state, result } = applyEdit(this.state, action, { merge, available: options.available });
    if (result.ok && result.changed) this.coalesceKey = key === '' ? undefined : key;
    this.set(state);
    return result;
  };

  undo = (): void => {
    this.coalesceKey = undefined;
    this.set(undo(this.state));
  };

  redo = (): void => {
    this.coalesceKey = undefined;
    this.set(redo(this.state));
  };

  get canUndo(): boolean {
    return canUndo(this.state);
  }

  get canRedo(): boolean {
    return canRedo(this.state);
  }

  /** The current rules are now what is saved (`rules`: what the server stored, if it differs). */
  markSaved = (rules?: EditableRules): void => {
    this.coalesceKey = undefined;
    this.set(markSaved(this.state, rules));
  };

  /**
   * The conversion now belongs to a format (a learn that has just been saved as one): from here on an edit of the output side is a change
   * to the format (SPEC 8.12). The rules, the undo history and `rev` stay as they are (nothing needs checking again).
   */
  setFormat = (format: FormatInfo | null): void => {
    this.set(withFormat(this.state, format));
  };

  /** Start over from other rules. */
  reset = (rules: EditableRules, options: EditorOptions = {}): void => {
    this.coalesceKey = undefined;
    // `rev` keeps counting, so a check result from before the reset is never mistaken for one of the new rules.
    const next: EditorState = { ...resetEditor(rules, options), rev: this.state.rev + 1 };
    this.state = next;
    for (const l of this.listeners) l();
  };
}
