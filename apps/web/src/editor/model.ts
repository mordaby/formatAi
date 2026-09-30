// The rules-editor model (SPEC 8.11): a pure state, typed edit actions, undo/redo. No React, no engine, no
// worker, no clock: `applyEdit(state, action)` returns the next state and either `ok` or typed problems, and
// on problems the state is unchanged. Every accepted edit leaves valid rules (zod + checkRules, SPEC 9.2
// layers 1-2); the engine-side layers (types, limits, format lock) are the worker's `staticChecks`.
import { applyRulesAction, type RulesAction } from './actions';
import { parseAdvancedJson } from './advanced';
import { editorConfig } from './config';
import { editedLines, formatFingerprint } from './lines';
import { fail, isProblems } from './problems';
import { isStored, sameContent } from './rulesUtil';
import type { ActionResult, EditableRules, EditAction, EditorOptions, EditorState, EditProblem, FormatInfo, Snapshot } from './types';
import { validateEdit } from './validate';

export * from './types';
export { applyColumnMethod, readColumnMethod, methodSources, mismatchMessage } from './columnMethod';
export { advancedJsonOf, parseAdvancedJson } from './advanced';
export { editedLines, formatFingerprint, lineIds, lineIdsOf } from './lines';
export { sourceOptions, effectiveEndSummaryRows, effectiveGroupSummaryRows } from './rulesUtil';
export { validateEdit } from './validate';

// ---------- exceptions ----------

function normalizeExceptions(rows: readonly number[]): number[] {
  return [...new Set(rows.filter((r) => Number.isInteger(r) && r >= 1))].sort((a, b) => a - b);
}

// ---------- deriving the flags ----------

function sameSnapshot(a: Snapshot, b: Snapshot): boolean {
  if (a.exceptions.length !== b.exceptions.length || a.exceptions.some((r, i) => r !== b.exceptions[i])) return false;
  return sameContent(a.rules, b.rules);
}

/** Everything in a state that follows from (rules, exceptions): edited lines, format change, dirty. */
function derive(state: EditorState, rules: EditableRules, exceptions: number[]): EditorState {
  const edited = new Set<string>(state.baseEdited);
  for (const id of editedLines(state.baseline, rules)) edited.add(id);
  const formatChange = state.format !== null && formatFingerprint(rules) !== formatFingerprint(state.saved.rules);
  return {
    ...state,
    rules,
    exceptions,
    edited,
    formatChange,
    dirty: !sameSnapshot({ rules, exceptions }, state.saved),
    rev: state.rev + 1,
  };
}

// ---------- creating ----------

export function createEditorState(rules: EditableRules, options: EditorOptions = {}): EditorState {
  const format: FormatInfo | null =
    options.format !== undefined ? options.format : isStored(rules) && rules.meta.formatId !== undefined ? { sourceCount: 1 } : null;
  const exceptions = normalizeExceptions(options.exceptions ?? []);
  const base = options.edited ?? [];
  return {
    rules,
    history: { past: [], future: [] },
    edited: new Set(base),
    exceptions,
    dirty: false,
    formatChange: false,
    format,
    rev: 0,
    baseline: rules,
    baseEdited: base,
    saved: { rules, exceptions },
    historyCap: options.historyCap ?? editorConfig.historyCap,
  };
}

// ---------- editing ----------

export interface ApplyOptions {
  /** Fold this edit into the previous undo step (typing in one field is one step, not one per key). */
  merge?: boolean;
}

export interface EditOutcome {
  state: EditorState;
  result: ActionResult;
}

function pushPast(state: EditorState): Snapshot[] {
  const past = [...state.history.past, { rules: state.rules, exceptions: state.exceptions }];
  return past.length > state.historyCap ? past.slice(past.length - state.historyCap) : past;
}

function nextRules(state: EditorState, action: EditAction): { rules: EditableRules; exceptions: number[] } | EditProblem[] {
  switch (action.type) {
    case 'markException':
    case 'unmarkException': {
      if (!Number.isInteger(action.row) || action.row < 1) {
        return fail({ code: 'badValue', message: 'a row number is a whole number from 1', path: 'row' });
      }
      const has = state.exceptions.includes(action.row);
      const exceptions =
        action.type === 'markException' ? (has ? state.exceptions : normalizeExceptions([...state.exceptions, action.row])) : state.exceptions.filter((r) => r !== action.row);
      return { rules: state.rules, exceptions };
    }
    case 'setAdvancedJson': {
      const parsed = parseAdvancedJson(action.text, state.rules);
      return isProblems(parsed) ? parsed : { rules: parsed, exceptions: state.exceptions };
    }
    default: {
      const out = applyRulesAction(state.rules, action as RulesAction);
      if (isProblems(out)) return out;
      const problems = validateEdit(state.rules, out);
      return problems.length > 0 ? problems : { rules: out, exceptions: state.exceptions };
    }
  }
}

/** Applies one edit. Problems leave the state untouched; an edit that changes nothing adds no undo step. */
export function applyEdit(state: EditorState, action: EditAction, options: ApplyOptions = {}): EditOutcome {
  const next = nextRules(state, action);
  if (isProblems(next)) return { state, result: { ok: false, problems: next } };
  const changed = !sameSnapshot({ rules: next.rules, exceptions: next.exceptions }, { rules: state.rules, exceptions: state.exceptions });
  if (!changed) return { state, result: { ok: true, changed: false } };
  const history = options.merge && state.history.past.length > 0 ? { past: state.history.past, future: [] } : { past: pushPast(state), future: [] };
  const base: EditorState = { ...state, history };
  return { state: derive(base, next.rules, next.exceptions), result: { ok: true, changed: true } };
}

// ---------- undo / redo ----------

export const canUndo = (state: EditorState): boolean => state.history.past.length > 0;
export const canRedo = (state: EditorState): boolean => state.history.future.length > 0;

export function undo(state: EditorState): EditorState {
  const past = state.history.past;
  const prev = past[past.length - 1];
  if (!prev) return state;
  const future = [{ rules: state.rules, exceptions: state.exceptions }, ...state.history.future];
  const base: EditorState = { ...state, history: { past: past.slice(0, -1), future } };
  return derive(base, prev.rules, prev.exceptions);
}

export function redo(state: EditorState): EditorState {
  const [next, ...rest] = state.history.future;
  if (!next) return state;
  const base: EditorState = { ...state, history: { past: pushPast(state), future: rest } };
  return derive(base, next.rules, next.exceptions);
}

// ---------- saving ----------

/** The current rules and exceptions are what is saved now: not dirty, and the format change has been written out. */
export function markSaved(state: EditorState, rules: EditableRules = state.rules): EditorState {
  const saved: Snapshot = { rules, exceptions: state.exceptions };
  const base: EditorState = { ...state, saved };
  return { ...derive(base, rules, state.exceptions), rev: state.rev };
}

/** Start over from other rules (a different conversion, or rules the server sent back after a save). */
export function resetEditor(rules: EditableRules, options: EditorOptions = {}): EditorState {
  return createEditorState(rules, options);
}
