// React wrapper over `EditorStore` (see store.ts): the rules editor's state, its edit actions, undo and redo.
import { useMemo, useState, useSyncExternalStore } from 'react';
import { EditorStore } from './store';
import type { ActionResult, EditableRules, EditAction, EditorOptions, EditorState } from './types';
import type { ApplyActionOptions } from './store';

export interface UseEditor {
  state: EditorState;
  /** Applies an edit and answers right away: `{ ok: true }` or the typed problems (the state is then unchanged). */
  apply(action: EditAction, options?: ApplyActionOptions): ActionResult;
  undo(): void;
  redo(): void;
  canUndo: boolean;
  canRedo: boolean;
  /** The current rules are what is saved now (pass the rules the server stored, if they differ). */
  markSaved(rules?: EditableRules): void;
  /** Start over from other rules. */
  reset(rules: EditableRules, options?: EditorOptions): void;
  /** The store itself, for code outside React (tests, the save flow). */
  store: EditorStore;
}

/** The store is created once from `rules`/`options`; use `reset` to load other rules. */
export function useEditor(rules: EditableRules, options: EditorOptions = {}): UseEditor {
  const [store] = useState(() => new EditorStore(rules, options));
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  return useMemo(
    () => ({
      state,
      apply: store.apply,
      undo: store.undo,
      redo: store.redo,
      canUndo: state.history.past.length > 0,
      canRedo: state.history.future.length > 0,
      markSaved: store.markSaved,
      reset: store.reset,
      store,
    }),
    [state, store],
  );
}
