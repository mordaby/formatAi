// The rules editor's headless logic (SPEC 8.11, 8.12): a pure model, a store, a live-check scheduler and React
// hooks. The UI (rules map, editor panels) is built on this; nothing here renders anything, and nothing here
// imports the engine barrel (only `@formatai/engine/formula`), so it is safe on the main thread.
//
//   const editor = useEditor(rules, { format?: { sourceCount }, exceptions?, edited? });
//   const check  = useLiveCheck({ engine, exampleId, editor: editor.state, tier, format? });
//
//   editor.apply(action)   -> { ok: true, changed } | { ok: false, problems: EditProblem[] }   (see EditAction)
//   editor.state           -> rules, edited (line ids), exceptions, dirty, formatChange, format, rev
//   readColumnMethod(rules, i) / sourceOptions(rules)      what a column editor shows
//   advancedJsonOf(rules)  / { type: 'setAdvancedJson' }   the Advanced view
//   check.state.live       "Matches X of Y rows", per-column counts, preview (mismatches first), layout problems
//   check.apply()          the check on every row (above 5,000 example rows the live check sees a subset)
//   check.saveStatus       blocked (static problems, in plain words) | checking | checkFailed | noExample
//                          | verified | differences (N)
export * from './model';
export { EditorStore, type ApplyActionOptions } from './store';
export { useEditor, type UseEditor } from './useEditor';
export { useLiveCheck, type UseLiveCheck, type UseLiveCheckOptions } from './useLiveCheck';
export { LiveCheckScheduler, type CheckEngine, type CheckInput, type LiveCheckState, type SchedulerOptions } from './liveCheckScheduler';
export { computeSaveStatus, differencesOf, metaStatusOf, stampStatus, type SaveInputs, type SaveStatus } from './saveStatus';
export { explainStaticProblems, type ExplainedProblem } from './explain';
export { editorConfig } from './config';
export { idInfos, typeOfId } from './rulesUtil';
