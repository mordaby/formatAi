// The rules-editor model (SPEC 8.11): a pure state, typed edit actions, undo/redo. No React, no engine, no
// worker, no clock: `applyEdit(state, action)` returns the next state and either `ok` or typed problems, and
// on problems the state is unchanged. Every accepted edit leaves valid rules (zod + checkRules, SPEC 9.2
// layers 1-2); the engine-side layers (types, limits, format lock) are the worker's `staticChecks`.
import { applyRulesAction, type RulesAction } from './actions';
import { parseAdvancedJson } from './advanced';
import { editorConfig } from './config';
import { editedLines, formatFingerprint, inputSideChanged } from './lines';
import { fail, isProblems } from './problems';
import { availableInputs, isStored, referencedIds, sameContent, withInputColumns } from './rulesUtil';
import type { ActionResult, EditableRules, EditAction, EditorOptions, EditorState, EditProblem, ExampleInputColumn, FormatInfo, OneTimeCell, Snapshot, SourceInfo } from './types';
import { validateEdit } from './validate';

export * from './types';
export { applyColumnMethod, readColumnMethod, methodSources, mismatchMessage } from './columnMethod';
export { advancedJsonOf, parseAdvancedJson } from './advanced';
export { editedLines, formatFingerprint, inputSideChanged, lineIds, lineIdsOf } from './lines';
export { sourceOptions, availableInputs, effectiveEndSummaryRows, effectiveGroupSummaryRows } from './rulesUtil';
export { validateEdit } from './validate';

// ---------- exceptions ----------

function normalizeExceptions(rows: readonly number[]): number[] {
  return [...new Set(rows.filter((r) => Number.isInteger(r) && r >= 1))].sort((a, b) => a - b);
}

/** One-time cells: each once, by row then column. */
function normalizeOneTime(cells: readonly OneTimeCell[]): OneTimeCell[] {
  const seen = new Map<string, OneTimeCell>();
  for (const c of cells) if (Number.isInteger(c.exampleRow) && c.exampleRow >= 1) seen.set(`${c.exampleRow}\u0000${c.column}`, { exampleRow: c.exampleRow, column: c.column });
  return [...seen.values()].sort((a, b) => a.exampleRow - b.exampleRow || (a.column < b.column ? -1 : a.column > b.column ? 1 : 0));
}

// ---------- deriving the flags ----------

/**
 * Whether two snapshots hold the same. DECISION: the one-time cells count for an edit (an answer that changes only them is still one undo
 * step) but not for "unsaved changes": they are never saved, so they never differ from what is.
 */
function sameSnapshot(a: Snapshot, b: Snapshot, oneTime = true): boolean {
  if (a.exceptions.length !== b.exceptions.length || a.exceptions.some((r, i) => r !== b.exceptions[i])) return false;
  if (oneTime && (a.oneTime.length !== b.oneTime.length || a.oneTime.some((c, i) => c.exampleRow !== b.oneTime[i]!.exampleRow || c.column !== b.oneTime[i]!.column))) return false;
  return sameContent(a.rules, b.rules);
}

/** Everything in a state that follows from (rules, exceptions, one-time cells): edited lines, format change, dirty. */
function derive(state: EditorState, rules: EditableRules, exceptions: number[], oneTime: OneTimeCell[]): EditorState {
  const edited = new Set<string>(state.baseEdited);
  for (const id of editedLines(state.baseline, rules)) edited.add(id);
  const formatChange = state.format !== null && formatFingerprint(rules) !== formatFingerprint(state.saved.rules);
  const sourceChange = state.source !== null && inputSideChanged(state.saved.rules, rules);
  return {
    ...state,
    rules,
    exceptions,
    oneTime,
    edited,
    formatChange,
    sourceChange,
    dirty: !sameSnapshot({ rules, exceptions, oneTime }, state.saved, false),
    rev: state.rev + 1,
  };
}

// ---------- creating ----------

export function createEditorState(rules: EditableRules, options: EditorOptions = {}): EditorState {
  const format: FormatInfo | null =
    options.format !== undefined ? options.format : isStored(rules) && rules.meta.formatId !== undefined ? { sourceCount: 1 } : null;
  const exceptions = normalizeExceptions(options.exceptions ?? []);
  const oneTime = normalizeOneTime(options.oneTime ?? []);
  const base = options.edited ?? [];
  return {
    rules,
    history: { past: [], future: [] },
    edited: new Set(base),
    exceptions,
    oneTime,
    dirty: false,
    formatChange: false,
    format,
    source: options.source ?? null,
    sourceChange: false,
    rev: 0,
    baseline: rules,
    baseEdited: base,
    saved: { rules, exceptions, oneTime },
    historyCap: options.historyCap ?? editorConfig.historyCap,
  };
}

// ---------- editing ----------

export interface ApplyOptions {
  /** Fold this edit into the previous undo step (typing in one field is one step, not one per key). */
  merge?: boolean;
  /**
   * The example input's columns (SPEC 8.11). An edit that uses one no rule declares yet (its id is the one
   * `sourceOptions` gave it) declares it first, in the same undoable step.
   */
  available?: readonly ExampleInputColumn[] | undefined;
}

export interface EditOutcome {
  state: EditorState;
  result: ActionResult;
}

function pushPast(state: EditorState): Snapshot[] {
  const past = [...state.history.past, { rules: state.rules, exceptions: state.exceptions, oneTime: state.oneTime }];
  return past.length > state.historyCap ? past.slice(past.length - state.historyCap) : past;
}

/** The plain step, then the check every edit gets (SPEC 9.2 layers 1-2). */
function stepAndValidate(rules: EditableRules, action: EditAction): EditableRules | EditProblem[] {
  const out = applyRulesAction(rules, action as RulesAction);
  if (isProblems(out)) return out;
  const problems = validateEdit(rules, out);
  return problems.length > 0 ? problems : out;
}

/**
 * The same step with the example input's undeclared columns declared, keeping only those the step ended up using. Used
 * when the plain step failed: choosing a column of the example that no rule declares yet is one edit that declares it and
 * uses it (undo takes both back).
 */
function stepDeclaring(
  rules: EditableRules,
  action: EditAction,
  available: readonly ExampleInputColumn[] | undefined,
  failed: EditProblem[],
): EditableRules | EditProblem[] {
  const candidates = availableInputs(rules, available);
  if (candidates.length === 0) return failed;
  const all = withInputColumns(rules, candidates.map((c) => c.column));
  const out = applyRulesAction(all, action as RulesAction);
  if (isProblems(out)) return out;
  const used = referencedIds(out);
  const keep = new Set(candidates.filter((c) => used.has(c.id)).map((c) => c.id));
  if (keep.size === 0) return failed;
  const declared = out.input.columns.filter((c) => keep.has(c.id) || !candidates.some((k) => k.id === c.id));
  const next = { ...out, input: { ...out.input, columns: declared } } as EditableRules;
  const problems = validateEdit(rules, next);
  return problems.length > 0 ? problems : next;
}

function nextRules(state: EditorState, action: EditAction, available?: readonly ExampleInputColumn[]): Snapshot | EditProblem[] {
  const keep = { exceptions: state.exceptions, oneTime: state.oneTime };
  switch (action.type) {
    case 'markException':
    case 'unmarkException': {
      if (!Number.isInteger(action.row) || action.row < 1) {
        return fail({ code: 'badValue', message: 'a row number is a whole number from 1', path: 'row' });
      }
      const has = state.exceptions.includes(action.row);
      const exceptions =
        action.type === 'markException' ? (has ? state.exceptions : normalizeExceptions([...state.exceptions, action.row])) : state.exceptions.filter((r) => r !== action.row);
      return { rules: state.rules, exceptions, oneTime: state.oneTime };
    }
    case 'setAdvancedJson': {
      const parsed = parseAdvancedJson(action.text, state.rules);
      return isProblems(parsed) ? parsed : { rules: parsed, ...keep };
    }
    case 'replaceRules': {
      const problems = validateEdit(state.rules, action.rules);
      if (problems.length > 0) return problems;
      return { rules: action.rules, exceptions: state.exceptions, oneTime: action.oneTime ? normalizeOneTime(action.oneTime) : state.oneTime };
    }
    default: {
      let out = stepAndValidate(state.rules, action);
      if (isProblems(out) && available && available.length > 0) out = stepDeclaring(state.rules, action, available, out);
      return isProblems(out) ? out : { rules: out, ...keep };
    }
  }
}

const snapshotOf = (state: EditorState): Snapshot => ({ rules: state.rules, exceptions: state.exceptions, oneTime: state.oneTime });

/** Applies one edit. Problems leave the state untouched; an edit that changes nothing adds no undo step. */
export function applyEdit(state: EditorState, action: EditAction, options: ApplyOptions = {}): EditOutcome {
  const next = nextRules(state, action, options.available);
  if (isProblems(next)) return { state, result: { ok: false, problems: next } };
  const changed = !sameSnapshot(next, snapshotOf(state));
  if (!changed) return { state, result: { ok: true, changed: false } };
  const history = options.merge && state.history.past.length > 0 ? { past: state.history.past, future: [] } : { past: pushPast(state), future: [] };
  const base: EditorState = { ...state, history };
  return { state: derive(base, next.rules, next.exceptions, next.oneTime), result: { ok: true, changed: true } };
}

// ---------- undo / redo ----------

export const canUndo = (state: EditorState): boolean => state.history.past.length > 0;
export const canRedo = (state: EditorState): boolean => state.history.future.length > 0;

export function undo(state: EditorState): EditorState {
  const past = state.history.past;
  const prev = past[past.length - 1];
  if (!prev) return state;
  const future = [snapshotOf(state), ...state.history.future];
  const base: EditorState = { ...state, history: { past: past.slice(0, -1), future } };
  return derive(base, prev.rules, prev.exceptions, prev.oneTime);
}

export function redo(state: EditorState): EditorState {
  const [next, ...rest] = state.history.future;
  if (!next) return state;
  const base: EditorState = { ...state, history: { past: pushPast(state), future: rest } };
  return derive(base, next.rules, next.exceptions, next.oneTime);
}

// ---------- saving ----------

/** The current rules and exceptions are what is saved now: not dirty, and the format change has been written out. */
export function markSaved(state: EditorState, rules: EditableRules = state.rules): EditorState {
  const saved: Snapshot = { rules, exceptions: state.exceptions, oneTime: state.oneTime };
  const base: EditorState = { ...state, saved };
  return { ...derive(base, rules, state.exceptions, state.oneTime), rev: state.rev };
}

/** The conversion belongs to a format (or no longer does): the format-change flag follows. Not an edit: `rev` and the history stay. */
export function withFormat(state: EditorState, format: FormatInfo | null): EditorState {
  return { ...state, format, formatChange: format !== null && formatFingerprint(state.rules) !== formatFingerprint(state.saved.rules) };
}

/** The conversion's source is known (or no longer is): the source-change flag follows. Not an edit: `rev` and the history stay. */
export function withSource(state: EditorState, source: SourceInfo | null): EditorState {
  return { ...state, source, sourceChange: source !== null && inputSideChanged(state.saved.rules, state.rules) };
}

/** Start over from other rules (a different conversion, or rules the server sent back after a save). */
export function resetEditor(rules: EditableRules, options: EditorOptions = {}): EditorState {
  return createEditorState(rules, options);
}
