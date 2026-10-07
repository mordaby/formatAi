// learnFromExamples (SPEC 5 flow A/A2): the end-to-end learn pipeline, from the two
// example files to a verified (or best-effort) rules file. Pure orchestration - every
// real decision (pre-flight, the fast path, masking, the payload, full verification,
// the learning loop's next step) is already implemented elsewhere in this package; this
// module only sequences them exactly as SPEC 5 flow A describes, steps 1-6 (step 7, "show
// the rules map", and step 8, "saving", are UI/registry concerns outside the engine).
//
// AI code checks (learn-v9, docs/proposals/ai-code-checks.md): when the answer is checks instead of rules, the flow answers them on every row
// of the example (`learn/checks.ts`, masked like the samples, within the learn's row limit) and makes the next step (`callStep`, with every
// round so far), until the rules come - at most `limits.learn.checks.maxRounds` rounds. From the rules on, nothing changes.
//
// Logic first (docs/proposals/saved-format-contents.md section 4; SPEC 21 v15): when the answer the loop kept has a LIST column (`copiedLists`:
// a lookup, a value map or a chain of cases with fixed values keyed on an input column, not a small vocabulary), the flow sends ONE automatic
// repair round for it, with no click - the `list` problem names the column, the number of values and the key column, never a value
// (`listRetryProblems`) - within the loop's caps (it is a round of the loop: `limits.learn.loop.maxRounds`, the API's repair calls). With
// learn-v9 the AI step may answer that round with checks first (`callRepair` with `LoopRound.checks`). An answer without the list (logic
// found) replaces the kept one when it is no worse on every row; one that keeps it changes nothing - the list is used for the conversion and
// asked about at Save. The overfitting guards keep their own one repair (an `overfit` problem never rides in this round, and this round is
// not it).
//
// Deliberately transport-agnostic: `callLearn`/`callRepair`/`callStep` are injected by the caller,
// so the SAME sequence runs whether they call the real `POST /api/learn` (the browser)
// or `apps/api/src/learn`'s `learn()`/`repairFromBrowser` in-process (the eval harness,
// SPEC 10). No DOM/Node APIs; no randomness beyond what a given `key` already carries.
import { aiNotesOf, isCodeCheck, limits, payloadRowCount, stepBytes, stripAiNotes, unsupportedDespiteEvidence, withRows, type AiColumnNote, type AiStepPartCode, type Check, type CheckAnswer, type CheckRound, type ColumnClassHints, type Format, type LearnAlternative, type LearnPayload, type LearnResult, type RepairProblem, type Rules, type Tier } from '@formatai/shared';
import { answerChecks, checkSummaryOf, withoutRows, type CheckSummary } from './checks';
import { deepEqual } from '../registry/deepEqual';
import { columnVerifier, resolveAlternatives, type AlternativeResult } from './alternatives';
import { fillParams, type FillAmbiguity, type FillResult, type FillSummary } from './fillParams';
import { copiedLists, listRetryProblems, oneTimeQuestions, questionedPositions, type OneTimeOptions, type OneTimeResult } from './oneTimers';
import { sniffDelimitedText } from '../io/detectFileSpec';
import { readWorkbook } from '../io/read';
import type { AnalysisProgress, AnalyzeOptions, PairAnalysis } from './analyze';
import { analyzePair } from './analyze';
import { checkFixedLock, type FixedProblem } from '../registry/checkFixedLock';
import { restoreFixed } from '../registry/restoreFixed';
import { columnsWithRule, completionProduced, isCompletable, learnResultOf, type CompleteOptions } from './complete';
import { ambiguousColumns, fastPath } from './fastPath';
import { loopCaps, loopStep, startLoop, wrongCount, type LoopRound, type LoopSummary } from './loop';
import { createMasker, unmaskRules, type Masker } from './mask';
import { maskFixedRules } from './maskFixed';
import { partialRules, type PartialRulesResult } from './partial';
import { preflight, type PreflightResult } from './preflight';
import { aiReadiness, type AiReadiness } from './readiness';
import { OVERFIT_REASON, overfitFindings, overfitProblems, withOverfitFallback } from './overfit';
import { exampleTable, verifyAgainstExample, type VerifyResult, type WrongRow } from './verify';

/** What `callLearn`/`callRepair` return - the shape of `apps/api/src/learn`'s
 * `LearnOutcome` (`learn()`/`repairFromBrowser()`), minus the `verified` flag this
 * module derives for itself from the browser's own full verification. Generic over
 * the call-record type so this engine package never has to import `@formatai/api`'s
 * `LlmCallRecord` (the wrong dependency direction - apps/api depends on the engine,
 * not the other way around): the caller's own record type just flows through. */
export interface LearnCallResult<Call = unknown> {
  /** Wire-decoded but NOT unmasked: exactly what the LLM produced (fake vocabulary
   * when masking is on). `learnFromExamples` unmasks it itself before verifying. */
  rules: LearnResult | null;
  /** learn-v8: a second rule for some columns (`LearnResponse.alternatives`), in the same vocabulary as `rules`; tested on every row in `judge`. */
  alternatives?: LearnAlternative[];
  problems: RepairProblem[];
  calls: Call[];
  /**
   * The learn had its one repair for a rule that copies rows of the example (SPEC 9.2 layer 6): a call behind this result sent an `overfit`
   * problem (`LearnResponse.overfitRepaired`). From then on such a rule is reported as unsupported, never sent back again.
   */
  overfitRepaired?: boolean;
  /**
   * AI code checks (learn-v9): the AI step asked code to check ideas on every row before it answers (`LearnResponse.checks`, as the API
   * validated and capped them) - `rules` is then null. `learnFromExamples` answers them and makes the next step (`callStep`).
   */
  checks?: Check[];
  /** With `checks`: one short line per check the API dropped, for the next round (`CheckRound.dropped`). */
  droppedChecks?: string[];
}

export interface LearnFromExamplesOptions<Call = unknown> {
  input: { bytes: Uint8Array; name: string };
  output: { bytes: Uint8Array; name: string };
  /** SPEC 7.2: on by default in the UI; passed explicitly here since the engine has no
   * default of its own. */
  masking: boolean;
  /**
   * The masking HMAC key (SPEC 7.2): "random per browser session and never leaves the
   * browser". Generated by the caller (`crypto.getRandomValues` in the browser; a
   * seeded key in the eval harness for determinism) - this module never generates
   * randomness. Required when `masking` is true.
   */
  key?: Uint8Array;
  tier: Tier;
  /** SPEC 8.12/A2: attach mode - the existing format this input must produce. */
  target?: Format;
  /** SPEC 6.4: "Try anyway" past a "rows couldn't be aligned" warning. Trying anyway
   * still counts as a learn once it reaches the AI step, same as any other continued warn. It never
   * gets past the AI readiness gate (SPEC 21 v5 item 4): with no matched rows at all there is nothing
   * to learn from (`path: 'notReady'`). */
  tryAnyway?: boolean;
  /**
   * SPEC 21 v5 item 1: whether this caller may use the AI step at all. 'notAllowed' (a user who isn't
   * signed in) never reaches the LLM: when the fast path can't finish, the learn returns the local
   * partial result (`path: 'partial'`) instead, with the columns that need the AI step listed. Default
   * 'allowed' (the existing behavior). `callLearn` is never called when 'notAllowed'.
   */
  ai?: 'allowed' | 'notAllowed';
  /**
   * Completion mode (LEARN_PROMPT "Completing a partial rules file"): the user already has part of the rules
   * (`fixedRules`, exactly as they are on screen) and the AI step only produces what is listed - output
   * `columns` and layout `parts`. The fast path and the local partial result are skipped (the caller decided the AI
   * step is wanted), the payload carries `complete`, and the answer must pass the fixed lock (`checkFixedLock`) as
   * well as the full verification - see `LearnFromExamplesResult.completion`. Not combined with `target`.
   */
  complete?: CompleteOptions;
  /** SPEC 5 A step 5: one learn action (however many calls it takes under the hood -
   * server repair rounds and escalation are `callLearn`'s own business, e.g.
   * `apps/api/src/learn`'s `learn()`). */
  callLearn: (payload: LearnPayload) => Promise<LearnCallResult<Call>>;
  /**
   * SPEC 5 A step 6 / 9.3: a browser-triggered repair call - one round of the learning loop (`learn/loop.ts`), made only when the
   * browser's own full verification (not `callLearn`'s internal sample-run checks) finds a mismatch, at most `limits.learn.loop.maxRounds`
   * times. `previousRules` is passed back in the SAME (possibly masked) vocabulary `callLearn` returned - never the unmasked copy this
   * module verifies with - because the API holds no masking key and can only recognize its own prior fake words (SPEC 7.2/15: the key, and
   * so the fake<->real map, never leaves the browser). `round.rows` are every row the loop sent so far, masked (the request's `rows`).
   */
  callRepair?: (payload: LearnPayload, previousRules: LearnResult, problems: RepairProblem[], round: LoopRound) => Promise<LearnCallResult<Call>>;
  /**
   * AI code checks (learn-v9, docs/proposals/ai-code-checks.md): one step of a learn whose AI step asked checks - the browser's `POST
   * /api/learn/step` (`{ token: learnId, payload, rounds }`), the eval's `learn()` with the rounds. `rounds` is every round so far, this one
   * last: the checks as `callLearn` / the last step returned them and the answers code gave (masked like the samples). Its result is like
   * `callLearn`'s: more checks (while rounds are left) or the rules. Without it a checks answer is no answer (no rules), and a learn that asks
   * none runs exactly as before.
   */
  callStep?: (payload: LearnPayload, rounds: CheckRound[]) => Promise<LearnCallResult<Call>>;
  /**
   * The payload's pattern hints (`bands`, `dependsOn`, `contains`; `BuildPayloadOptions.patternHints`): default true, as always. False is the
   * eval's `--no-pattern-hints`, which measures the AI code checks against them (docs/proposals/ai-code-checks.md section 8).
   */
  patternHints?: boolean;
  /**
   * An external classification of the columns, by header (column classification, owner 2026-10-06; `learn/classify.ts`): the hook for the
   * AI step that will classify columns from their names. It may tighten any column to masked, and loosen a text column to a category (sent
   * real) only when code confirms it; it never loosens an identifier. Every path that masks reads it through the analysis.
   */
  columnHints?: ColumnClassHints;
  onProgress?: (p: AnalysisProgress) => void;
  /**
   * Called once with the successful pair analysis, before pre-flight. The web worker keeps it
   * in memory so the rules editor's live check (SPEC 8.11) can re-run the rules on the example
   * without reading the two files again. Purely an observer: it cannot change the flow.
   */
  onAnalysis?: (analysis: PairAnalysis) => void;
  /**
   * Engine audit (2026-10-07): the time budget for code's work on one AI answer (fill, guards, verification, alternatives), default
   * `limits.learn.judge.timeBudgetMs`; see `LearnFromExamplesResult.timeBudget`. `now` is the clock it is read with (tests).
   */
  judgeBudgetMs?: number;
  now?: () => number;
}

/**
 * blocked: pre-flight (SPEC 6.3) stopped it.  local: the strict fast path finished it, no LLM.
 * llm: the AI step ran.  partial (v5): the local partial result - see `LearnFromExamplesResult.partial`.
 * notReady (v5): the AI readiness gate stopped the AI step - see `readiness`; nothing was consumed.
 */
export type LearnPath = 'blocked' | 'local' | 'llm' | 'partial' | 'notReady';

/**
 * DECISION: SPEC 10's report needs per-stage shares ("share blocked, share fast path
 * ... verified on the first call, and verified after repair") that aren't fully
 * recoverable from `path`/`calls` alone (e.g. "verified on the first call" must mean
 * *before* any browser-triggered repair, which only this module knows about). This
 * summary is that bookkeeping, kept separate from `path` (which already answers
 * "blocked vs local vs llm") so callers - chiefly the eval runner - don't have to
 * re-derive it from `calls[].outcome` and guesswork.
 */
export interface LearnStages {
  preflight: PreflightResult['status'];
  fastPathTried: boolean;
  fastPathSucceeded: boolean;
  llmCalled: boolean;
  /** Full verification passed right after `callLearn` (+ unmask), before any
   * browser-triggered repair - and the answer gave up on no column the pair analysis had found a relation for
   * (`unsupportedDespiteEvidence`: that alone is a reason for the repair call). Meaningless (always false) off the LLM path. */
  verifiedFirstCall: boolean;
  /** At least one round of the learning loop was made (`LearnFromExamplesResult.loop` says how many). */
  browserRepairUsed: boolean;
  /** Final verification result: of the answer kept (the best of the loop's answers) when a round was made,
   * otherwise the same as `verifiedFirstCall` (or the fast path's own verification). */
  verifiedAfterRepair: boolean;
  /** v5: the AI readiness gate ran (the fast path did not finish the learn). */
  readinessChecked?: boolean;
  /** v5: the gate stopped the AI step with a block (`path: 'notReady'`). */
  readinessBlocked?: boolean;
  /** v5: the local partial result was built and returned (`path: 'partial'`). */
  partialBuilt?: boolean;
}

/** v5 item 1: what the local partial result holds and why it was returned. */
export interface PartialInfo {
  /** The caller may not use the AI step (sign in to finish). It is the only reason: a result is never finished locally because the
   * remaining columns "look external" - the AI step tries every column code couldn't explain (SPEC 6.4, 21 v7 note). */
  reason: 'aiNotAllowed';
  /** Headers of the output columns code built (and `verification` counts). */
  solved: string[];
  /** Headers of EVERY output column that needs the AI step: the ones with a dependency or composition code couldn't turn into a rule,
   * and the ones it found no relation to the input for at all (`external`). */
  needsAi: string[];
  /** The subset of `needsAi` whose values code could not find in the input file: they "may come from another source" (wording only). */
  external: string[];
  /** Output column positions of `solved`. */
  solvedColumns: number[];
  /** What besides columns still needs the AI step (rows that change shape, dropped rows, sort, groups, ...). */
  needsAiParts: AiStepPartCode[];
}

export interface LearnFromExamplesResult<Call = unknown> {
  path: LearnPath;
  preflight: PreflightResult;
  /** UNMASKED (real) rules, ready to show/save/run - or null when blocked, or the LLM
   * never returned anything usable even after repair. */
  rules: LearnResult | null;
  /** Full-file verification (SPEC 5 A step 6) of `rules` - or null when blocked or
   * `rules` is null (nothing to verify). On the LLM path (plain learn) a column the answer reports as unsupported is not compared: the
   * verification covers the columns that have a rule, and `verified` means everything produced matches (never true when nothing was). */
  verification: VerifyResult | null;
  assumptions: LearnResult['assumptions'];
  unsupported: LearnResult['unsupported'];
  calls: Call[];
  stages: LearnStages;
  /** path 'partial': see `PartialInfo`. `rules` are the partial rules; `verification` counts the solved columns only. */
  partial?: PartialInfo;
  /**
   * learn-v7 (SPEC 8.10, 15): the AI step's notes on the columns it reported as unsupported, taken OUT of `rules`: its plain-language guess
   * at the rule (unmasked here, real words) and whether a function request for the column was recorded. For the session only - the caller
   * shows them and never stores them; `rules` and `unsupported` never carry them, so nothing that saves, caches or re-sends the rules can.
   */
  aiNotes?: AiColumnNote[];
  /** The AI readiness verdict, when the gate ran (paths 'notReady', 'partial' and 'llm'). Issues carry codes and
   * params for `aiReadinessMessages`; the payload the check built is not included. */
  readiness?: AiReadiness;
  /**
   * Completion mode, path 'llm' with rules: what was asked, and the fixed lock's findings on the (unmasked) answer against the
   * real fixed rules. The answer may replace the user's rules only when `fixedProblems` is empty AND `matches`.
   */
  completion?: {
    columns: number[];
    parts: AiStepPartCode[];
    fixedProblems: FixedProblem[];
    /**
     * The answer matches the example as far as the AI step is responsible for it: every cell of a column it produced matches, and it made
     * nothing worse anywhere else - a difference the user's own rules already had (an edit that departs from the example on purpose, a
     * layout part still missing) is not counted against it, and neither is a column that still has no rule (the AI step may report a
     * listed column as unsupported; it is left empty, and the editor says "needs your input").
     */
    matches: boolean;
    /** What the answer produced of what was asked: listed columns that got a rule, listed parts it built. Nothing produced is no completion. */
    produced: { columns: number; parts: number };
  };
  /** The learning loop (path 'llm' with rules): rounds made (the list's round included), rows they sent, and how it ended. `rules` is its best answer. */
  loop?: LoopSummary;
  /**
   * Path 'llm' with rules: the one automatic round for the kept answer's list columns (docs/proposals/saved-format-contents.md section 4) -
   * the columns retried, the calls it took (its own rounds of checks included) and how it ended: `logic` (the answer came back without the
   * list: it is gone), `kept` (the answer keeps the list: it is used and asked about at Save), `worse` (the answer was worse on the example: the
   * one before is kept, list and all), `noAnswer` (no usable rules came back). Absent when the kept answer had no list, or no round was left.
   */
  listRetry?: ListRetrySummary;
  /**
   * Path 'llm': the AI code checks the AI step asked before it answered (learn-v9) - rounds, checks, rows shown, dropped, errors. Counts
   * only, for the eval report and the UI's progress line. Absent when it asked none.
   */
  checks?: CheckSummary;
  /**
   * Path 'llm' with rules: what code filled in the kept answer from every row of the example (`fillParams`, proposal 7.1) - kinds and
   * counts only, never a value: for the UI's note ("we completed the branch table from your example: 48 entries") and the eval report.
   */
  filled?: FillSummary;
  /**
   * Path 'llm' with rules, learn-v8: what code found for each alternative the kept answer gave (`learn/alternatives.ts`) - per column,
   * both rules fit every row (`bothPass`: the user is asked; `question` is the ambiguity question, and `rules` carry its check until they
   * answer), only the answer's (`answerOnly`), only the alternative's (`alternativeOnly`: it is the rule now), or neither (`bothFail`).
   * Absent when the answer gave none.
   */
  alternatives?: AlternativeResult[];
  /**
   * Path 'llm' with rules: what the example could not settle, for the ambiguity question (proposal 7.2). Today one kind:
   * `{ kind: 'dayMonthOrder', column, format, other }` - every date text of the input column `column` reads both ways, so the rules keep
   * the AI's `format`; answering "the other way" is `swapDayMonth(rules, ambiguity)`. Absent when there is none.
   */
  ambiguities?: FillAmbiguity[];
  /**
   * Path 'llm' with rules: a one-time edit or a rule? (SPEC 21 v12 item 20, `oneTimers.ts`) - the parts of the kept answer that explain exactly
   * one row of the example, singled out by something unique to it (its ID, an exact amount or date, its position), for the Result screen's
   * question (at most `limits.learn.oneTimer.maxQuestions`; completion mode: the asked columns only), and the columns that had more such parts
   * than fit (handed to the overfitting guards, not asked). With them (owner amendment, 2026-10-06), `kind: 'copiedList'`: a column whose
   * lookup table or value map is keyed on a column that is different on every row of the example (asked at Save: "Keep this list in the
   * saved format?"; no cell value). Real values: the browser's and the eval's only. Absent when there is neither.
   */
  oneTimers?: OneTimeResult;
  /**
   * Engine audit (2026-10-07; `limits.learn.judge`): present when code's work on an AI answer took longer than the budget - the learn
   * stopped there (loop end `timeBudget`) with the best answer so far. `skipped` says what was not done: `fill` (conditions left as the AI
   * wrote them), `alternatives` (not tried), `rounds` (no further repair round), `listRound` (the list's one round not made). The answer is
   * verified only when every row matched; otherwise its differences are the user's ("needs your input"). Counts and names only.
   */
  timeBudget?: TimeBudgetSummary;
}

/** `LearnFromExamplesResult.timeBudget`. */
export interface TimeBudgetSummary {
  budgetMs: number;
  /** The longest answer's time (ms). */
  answerMs: number;
  skipped: ('fill' | 'alternatives' | 'rounds' | 'listRound')[];
}

/** How the one round for the kept answer's lists went (`LearnFromExamplesResult.listRetry`). Headers and counts only. */
export interface ListRetrySummary {
  columns: string[];
  calls: number;
  /** learn-v9: the rounds of checks the AI step asked in it. */
  checkRounds: number;
  outcome: 'logic' | 'kept' | 'worse' | 'noAnswer';
}

/** Like the diff problems (LEARN_PROMPT §4: "At most 10 diff problems are sent"), a repair call needs enough fixed-lock findings to fix the pattern, not all of them. */
const MAX_FIXED_PROBLEMS = 10;

function emptyStages(status: PreflightResult['status']): LearnStages {
  return {
    preflight: status,
    fastPathTried: false,
    fastPathSucceeded: false,
    llmCalled: false,
    verifiedFirstCall: false,
    browserRepairUsed: false,
    verifiedAfterRepair: false,
    readinessChecked: false,
    readinessBlocked: false,
    partialBuilt: false,
  };
}

function blockedResult<Call>(pf: PreflightResult): LearnFromExamplesResult<Call> {
  return { path: 'blocked', preflight: pf, rules: null, verification: null, assumptions: [], unsupported: [], calls: [], stages: emptyStages(pf.status) };
}

/**
 * Runs SPEC 5 flow A/A2 end to end: read both files, analyze the pair, pre-flight,
 * the local fast path, the AI readiness gate (v5: which also builds the (optionally masked) payload, and
 * decides whether the AI step runs at all - see `ai`, `partial` and `readiness`), the learn call,
 * unmasking, full verification, and - when needed and offered - the learning loop: rounds of
 * browser-triggered repairs, each sending rows the rules got wrong, as `loopStep` decides.
 */
export async function learnFromExamples<Call = unknown>(opts: LearnFromExamplesOptions<Call>): Promise<LearnFromExamplesResult<Call>> {
  if (opts.masking && !opts.key) {
    throw new Error('learnFromExamples: masking is on but no key was given (SPEC 7.2: the key never leaves the browser, and this module never generates one)');
  }
  if (opts.complete) {
    if (opts.target) throw new Error('learnFromExamples: completion mode and attach mode (target) cannot be combined');
    if (opts.ai === 'notAllowed') throw new Error('learnFromExamples: completion mode is the AI step, but the AI step is not allowed');
    if (!isCompletable(opts.complete.fixedRules)) throw new Error('learnFromExamples: complete.fixedRules is not a valid rules file');
  }
  // Completion mode: a check only code writes in the user's rules (SPEC 8.8: a cut-off check holds two values of their rows, the marker of an
  // open question the other rule's constants), which is never sent (SPEC 7.2). The AI step gets their rules without it (the payload, the
  // fixed lock, what code puts back) and it is put back on the answer at the end.
  const userCodeChecks = opts.complete ? opts.complete.fixedRules.validations.filter(isCodeCheck) : [];
  const complete: CompleteOptions | undefined = opts.complete ? { ...opts.complete, fixedRules: withoutCodeChecks(opts.complete.fixedRules) } : undefined;

  // ---- SPEC 5 A step 1: read both files (sniff delimited output bytes so
  // detectFileSpec can see quote: 'all' - SPEC 8.13) ----
  const inputWb = await readWorkbook(opts.input.bytes, opts.input.name);
  const outputWb = await readWorkbook(opts.output.bytes, opts.output.name);
  const outputSniff = outputWb.fileType === 'csv' || outputWb.fileType === 'txt' ? sniffDelimitedText(opts.output.bytes) : undefined;

  const analysisOpts: AnalyzeOptions = {};
  if (opts.onProgress) analysisOpts.onProgress = opts.onProgress;
  if (outputSniff) analysisOpts.outputSniff = outputSniff;
  // SPEC 8.12/A2: the output must already match the format, so its file spec is the
  // format's own, not re-detected from this particular example.
  if (opts.target) analysisOpts.outputFileSpec = opts.target.output.file;
  if (opts.columnHints) analysisOpts.columnHints = opts.columnHints;

  const analysis = analyzePair(inputWb, outputWb, analysisOpts);
  if (analysis.ok) opts.onAnalysis?.(analysis);

  // ---- SPEC 5 A step 2 / 6.3-6.4: pre-flight ----
  const pf = preflight(analysis, opts.tier);
  if (pf.status === 'block') return blockedResult(pf);
  const rowsNotAligned = pf.issues.some((i) => i.code === 'rowsNotAligned');
  if (rowsNotAligned && !opts.tryAnyway) return blockedResult(pf);

  if (!analysis.ok) {
    // Unreachable: preflight() only returns a non-'block' status for a successful
    // analysis (see packages/engine/src/learn/preflight.ts).
    throw new Error('learnFromExamples: unreachable - pre-flight did not block a failed pair analysis');
  }

  const stages = emptyStages(pf.status);

  // ---- SPEC 5 A step 3 / 6.5: the local fast path. Skipped in attach mode: fastPath
  // has no format-lock awareness (SPEC 8.12 - output/sort/group must equal the
  // target's exactly), so an attached source always goes through the LLM, which is
  // told to copy `target` verbatim (LEARN_PROMPT "Adding a source to an existing
  // format"). ----
  if (!opts.target && !complete) {
    stages.fastPathTried = true;
    const fp = fastPath(analysis, pf);
    if ('rules' in fp) {
      stages.fastPathSucceeded = true;
      const verification = verifyAgainstExample(fp.rules, analysis);
      stages.verifiedFirstCall = verification.verified;
      stages.verifiedAfterRepair = verification.verified;
      return {
        path: 'local',
        preflight: pf,
        rules: fp.rules,
        verification,
        assumptions: fp.rules.assumptions,
        unsupported: fp.rules.unsupported,
        calls: [],
        stages,
      };
    }
  }

  // ---- SPEC 21 v5 item 4: the AI readiness gate, before any payload or LLM call. It also builds the
  // (optionally masked, SPEC 7.2) payload, which the learn call below then uses as it is. ----
  const ai = opts.ai ?? 'allowed';
  const masker: Masker | undefined = opts.masking ? createMasker(opts.key!) : undefined;
  // (The local partial result is only for a caller that may not use the AI step.)
  const partial = complete || ai !== 'notAllowed' ? null : localPartial(analysis, pf);
  const readiness = aiReadiness(analysis, pf, {
    ...(masker ? { masker } : {}),
    ...(opts.target ? { target: opts.target } : {}),
    ...(complete ? { complete } : {}),
    ...(opts.patternHints === false ? { patternHints: false } : {}),
  });
  stages.readinessChecked = true;
  const shownReadiness: AiReadiness = readiness.ready ? { ready: true } : readiness;

  // A block: the AI step can't succeed. Signed-out callers still get the local result unless it has no
  // example pairs at all (then signing in wouldn't help either).
  if (!readiness.ready) {
    const noPairs = readiness.issues.some((i) => i.code === 'noRowsMatched');
    if (partial && !noPairs) return partialResult(analysis, pf, partial, shownReadiness, stages);
    stages.readinessBlocked = true;
    return { path: 'notReady', preflight: pf, rules: null, verification: null, assumptions: [], unsupported: [], calls: [], stages, readiness: shownReadiness };
  }

  // The AI step isn't available to this caller: the local partial result is what they get (SPEC 21 v5 item 1).
  if (ai === 'notAllowed') {
    if (partial) return partialResult(analysis, pf, partial, shownReadiness, stages);
    return blockedResult(pf);
  }

  // ---- SPEC 5 A step 4 / 7: the payload (built by the gate) ----
  const payload: LearnPayload = readiness.built!.payload;

  // ---- SPEC 5 A step 5: the learn call ----
  stages.llmCalled = true;
  let learned = await opts.callLearn(payload);
  const calls: Call[] = [...learned.calls];
  const built = readiness.built!;

  // ---- AI code checks (learn-v9, docs/proposals/ai-code-checks.md): while the AI step asks checks instead of answering, code answers them on
  // every row of the example and the next step carries every round so far. The rows they show count toward the learn's row limit with the
  // payload's own and the loop's (the loop below never sends them again). No `callStep`: a checks answer is no answer. ----
  const rounds: CheckRound[] = [];
  const checkRows: number[] = [];
  while (learned.checks && !learned.rules && opts.callStep && rounds.length < limits.learn.checks.maxRounds) {
    const next = nextCheckRound(learned.checks, learned.droppedChecks ?? [], {
      analysis,
      masker,
      fixedRules: complete?.fixedRules,
      payload,
      rounds,
      sent: new Set([...built.sampleRows.map((r) => r.in), ...built.droppedRows, ...checkRows]),
      rowBudget: limits.learn.loop.maxRowsTotal - payloadRowCount(payload) - checkRows.length,
    });
    // (Even with counts only the step would pass the payload byte cap: no step can be made.)
    if (!next) break;
    rounds.push(next.round);
    checkRows.push(...next.rowsShown);
    learned = await opts.callStep(payload, [...rounds]);
    calls.push(...learned.calls);
  }
  const checkSummary = rounds.length > 0 ? { checks: checkSummaryOf(rounds, checkRows.length) } : {};

  if (!learned.rules) {
    return { path: 'llm', preflight: pf, rules: null, verification: null, assumptions: [], unsupported: [], calls, stages, readiness: shownReadiness, ...checkSummary };
  }

  // ---- SPEC 5 A step 6 / 9.2 layer 8: full verification on the real, unmasked data ----
  // DECISION (SPEC 4/8.10: a partial, correct rules file beats a complete, wrong one; an unsupported column is "needs your input", not an
  // error): a plain learn is checked on the columns that have a rule - one the AI step honestly reported as unsupported (`from: null` plus
  // an entry, typically `externalData`) would differ on every row and is left out, so the learn is `verified` when everything produced matches.
  // Nothing produced at all checks nothing (never verified). Amendment 2026-10-07 (engine audit): only those columns' CELLS are left out
  // (`skipColumns`) - the row count, the row order and the title, header, blank and summary rows are checked as always (`onlyColumns` skipped
  // them all, so rules missing the title, the blank and the "Total" rows were `verified`). When every column has a rule this is the full
  // verification. Completion mode keeps the full verification: its own `matchesExample` below already leaves out a column that has no rule.
  const verifyAnswer = (r: LearnResult): VerifyResult => {
    const base = { wrongRows: true, ...(masker ? { masker } : {}) };
    if (complete) return verifyAgainstExample(r, analysis, base);
    const withRule = new Set(columnsWithRule(r));
    if (withRule.size === 0) return verifyAgainstExample(r, analysis, { ...base, onlyColumns: [] });
    const without = r.output.columns.flatMap((_, c) => (withRule.has(c) ? [] : [c]));
    return verifyAgainstExample(r, analysis, without.length > 0 ? { ...base, skipColumns: without } : base);
  };
  // Completion mode: the answer must also still contain the user's rules, unchanged (the API checked this on the masked
  // copies; this is the same check on the real ones, before anything replaces what the user has).
  const asked = complete ? { columns: complete.columns, parts: complete.parts } : null;
  const fixedLock = (r: LearnResult): FixedProblem[] => (complete && asked ? checkFixedLock(r, complete.fixedRules, asked) : []);
  // The fixed rules in the answer's vocabulary (masked like `complete.fixed`), for putting back what an answer changed (`restoreFixed`).
  const maskedFixed = complete ? (masker ? maskFixedRules(learnResultOf(complete.fixedRules), masker, analysis) : learnResultOf(complete.fixedRules)) : null;
  // What "the answer is good" means: a plain learn - the full verification; completion - that too, but a column with no rule does not count.
  // DECISION: in completion mode "matches the example" is relative to the user's own rules - the AI step answers for the columns it produced
  // (every cell must match) and must not make anything else worse; a difference the fixed rules already had (an edit that departs from the
  // example on purpose, a part still missing) is not its fault. Against the raw example no edit of a header or a value could ever pass.
  // What the user's own rules already differ by, against the example:
  const before = complete ? verifyAgainstExample(complete.fixedRules, analysis, { wrongRows: true }) : null;
  const cellKey = (m: { exampleRow: number; column: string }): string => `${m.exampleRow}\u0000${m.column}`;
  const layoutKey = (i: { code: string; message: string }): string => `${i.code}\u0000${i.message}`;
  const hadCell = new Set(before?.mismatches.map(cellKey) ?? []);
  const hadLayout = new Set(before?.layoutIssues.map(layoutKey) ?? []);
  const hadExtra = new Map((before?.wrongRows ?? []).map((w) => [w.inRow, w.extra.length] as const));
  const headerAt = (r: LearnResult, c: number): string => r.output.columns[c]?.header ?? analysis.output.headers[c] ?? `column${c + 1}`;
  /** The mismatches an answer is answerable for (completion: see the DECISION above; a plain learn: all of them). */
  const blamed = (v: VerifyResult, r: LearnResult): { rows: WrongRow[]; layout: number; cells: number } => {
    if (!complete) return { rows: v.wrongRows ?? [], layout: v.layoutIssues.length, cells: v.mismatches.length };
    const noRule = new Set(r.output.columns.filter((c) => c.from === null).map((c) => c.header));
    const produced = new Set(complete.columns.map((i) => r.output.columns[i]).filter((c) => c !== undefined && c.from !== null).map((c) => c!.header));
    const counts = (m: { exampleRow: number; column: string }): boolean => !noRule.has(m.column) && (produced.has(m.column) || !hadCell.has(cellKey(m)));
    const rows: WrongRow[] = [];
    for (const w of v.wrongRows ?? []) {
      const cells = w.cells.filter((cell) => counts({ exampleRow: (analysis.output.dataRows[cell.outRow] ?? -1) + 1, column: headerAt(r, cell.out) }));
      const extra = w.extra.slice(hadExtra.get(w.inRow) ?? 0);
      if (cells.length > 0 || extra.length > 0) rows.push({ inRow: w.inRow, cells, extra });
    }
    return { rows, layout: v.layoutIssues.filter((i) => !hadLayout.has(layoutKey(i))).length, cells: v.mismatches.filter(counts).length };
  };
  const matchesExample = (v: VerifyResult, r: LearnResult): boolean => {
    if (!complete || !before) return v.verified;
    if (v.verified) return true;
    const b = blamed(v, r);
    return b.cells === 0 && b.layout === 0;
  };
  const passes = (v: VerifyResult, r: LearnResult, lock: readonly FixedProblem[]): boolean => lock.length === 0 && matchesExample(v, r);

  /** One answer of the loop, judged on every row of the example. */
  interface Judged {
    /** In the answer's own vocabulary (masked when masking is on): what a repair call sends back. */
    masked: LearnResult;
    /** Unmasked: what is verified, shown and saved. */
    rules: LearnResult;
    verification: VerifyResult;
    fixedProblems: FixedProblem[];
    /** The same findings for the repair call: the lock on the answer's own vocabulary, so a message never quotes an unmasked word. */
    sendFixed: FixedProblem[];
    passes: boolean;
    wrongRows: WrongRow[];
    wrong: number;
    /** What code filled in it (kinds and counts) and what the example could not settle. */
    fill: { summary: FillSummary; ambiguities: FillAmbiguity[] };
    /** learn-v8: what each of its alternatives turned out to be on every row. */
    alternatives: AlternativeResult[];
    /** The overfitting guards (SPEC 9.2 layer 6): the problems for a rule that copies rows, while the learn's one repair for it is unused. */
    overfit: RepairProblem[];
    /** What it was judged from, so the kept answer can be judged again with the fallback (`judge(answer, alternatives, true)`). */
    source: { answer: LearnResult; alternatives: readonly LearnAlternative[] };
    /** Engine audit (2026-10-07): the time code took on it (ms), and what the time budget left undone (`limits.learn.judge`). */
    ms: number;
    overBudget: ('fill' | 'alternatives')[] | null;
  }
  const now = opts.now ?? Date.now;
  const judgeBudgetMs = opts.judgeBudgetMs ?? limits.learn.judge.timeBudgetMs;
  // The columns the free engine already asks about (a constant the input could write too): an alternative adds no second question there.
  let codeAsked: Set<string> | undefined;
  const askedByCode = (): Set<string> => (codeAsked ??= new Set(ambiguousColumns(analysis).map((q) => q.header)));
  const verifyColumn = columnVerifier(analysis, masker);
  // The overfitting guards (SPEC 9.2 layer 6, `learn/overfit.ts`): ONE repair per learn for a rule that copies rows of the example - asked by
  // the API's checks or by a round of this loop - and from then on the honest fallback: the column is reported as unsupported by code.
  let overfitRepaired = learned.overfitRepaired === true;
  const allRows = exampleTable(analysis);
  // Completion mode: only the columns the AI step was asked for (the others are the user's own rules).
  const askedHeaders: ReadonlySet<string> | null = complete
    ? new Set(complete.columns.flatMap((i) => {
        const header = complete.fixedRules.output.columns[i]?.header;
        return header === undefined ? [] : [header];
      }))
    : null;
  /** How much a rule that copies rows weighs when answers are compared: every row of its column wrong (it holds for none but these). */
  const copyWeight = Math.max(1, analysis.alignment.rows.length);
  const judge = (answer: LearnResult, alternatives: readonly LearnAlternative[] = [], fallBack = false): Judged => {
    // Engine audit (2026-10-07): code's work on one answer has a time budget (`limits.learn.judge`), read between its steps.
    const started = now();
    const deadline = started + judgeBudgetMs;
    let masked = answer;
    let rules: LearnResult = masker ? unmaskRules(masked, masker) : masked;
    let fixedProblems = fixedLock(rules);
    // Completion mode: what the answer changed of the fixed rules is put back by code first (`restoreFixed`, on the answer's own vocabulary
    // so its new words stay as it wrote them), and the checks below decide on what comes out.
    if (fixedProblems.length > 0 && asked && maskedFixed) {
      masked = restoreFixed(masked, maskedFixed, asked);
      rules = masker ? unmaskRules(masked, masker) : masked;
      fixedProblems = fixedLock(rules);
    }
    // The overfitting guards, on the answer as the AI wrote it (before code fills anything) and every row of the example: an `overfit` problem
    // for the next round while the learn's one repair for it is unused; after it - or for the answer kept at the end (`fallBack`) - the
    // column is reported as unsupported by code, in both vocabularies, and the answer is checked without it.
    // Code fills the data parameters from every row (`fillParams`, proposal 7.1), on the REAL rules: lookup tables, value maps and lists,
    // cut-offs, the day/month order, the duplicate kept, the values a filter drops. `masked` - what a repair round sends back - stays the
    // answer as the AI wrote it, so nothing filled is ever sent. DECISION: a cut-off check is code's alone; one the answer wrote is dropped
    // (and so is a `sameAs` one, which the wire schema does not even offer).
    const fillOf = (r: LearnResult): FillResult => fillParams(withoutCodeChecks(r), analysis, { ...(complete ? { fixed: learnResultOf(complete.fixedRules) } : {}), deadline, now });
    let findings = overfitFindings(rules, { table: allRows }).filter((f) => askedHeaders === null || askedHeaders.has(f.outputColumn));
    // A one-time edit or a rule? (SPEC 21 v12 item 20, `oneTimers.ts`): a row-position condition that is a part the user will be asked about -
    // it explains one row of the example and nothing else - is the user's question, not a repair (the AI step cannot know whether that row was
    // edited by hand). DECISION: only `position` findings, and only for a column whose every one of them goes once its asked parts are taken out;
    // a case list or a table of amounts is never a few one-time edits (it has more single-row parts than are asked, or none that is).
    let early: FillResult | undefined;
    if (findings.some((f) => f.kind === 'position')) {
      early = fillOf(rules);
      const waived = questionedPositions(early.rules, analysis, findings, askedHeaders);
      if (waived.size > 0) findings = findings.filter((f) => !waived.has(f.outputColumn));
    }
    let overfit: RepairProblem[] = [];
    let fellBack = false;
    if (findings.length > 0 && (overfitRepaired || fallBack)) {
      masked = withOverfitFallback(masked, findings);
      rules = withOverfitFallback(rules, findings);
      fixedProblems = fixedLock(rules);
      fellBack = true;
    } else {
      overfit = overfitProblems(findings);
    }
    const filled = early && !fellBack ? early : fillOf(rules);
    rules = filled.rules;
    fixedProblems = fixedLock(rules);
    const fill = { summary: { filled: filled.filled, checks: filled.checks, ...(filled.stopped ? { stopped: true as const } : {}) }, ambiguities: filled.ambiguities };
    let verification = verifyAnswer(rules);
    // learn-v8: each alternative the answer gave is tested on every row - one more run of the rules, only its column compared - and the
    // outcome applied (`learn/alternatives.ts`): a question when both fit, the alternative as the rule when only it fits. No alternative:
    // nothing here runs. (Past the time budget none is tried: the answer's own rule stands.)
    let results: AlternativeResult[] = [];
    const overBudget: ('fill' | 'alternatives')[] = filled.stopped ? ['fill'] : [];
    if (alternatives.length > 0 && now() > deadline) overBudget.push('alternatives');
    else if (alternatives.length > 0) {
      const resolved = resolveAlternatives({ rules, masked, verification, alternatives, masker, verifyColumn, asked: askedByCode() });
      ({ rules, masked, verification, results } = resolved);
      fixedProblems = fixedLock(rules);
    }
    const sendFixed = fixedProblems.length > 0 && masker && asked && maskedFixed ? checkFixedLock(masked, maskedFixed, asked) : fixedProblems;
    const b = blamed(verification, rules);
    // DECISION: a rule that copies rows - one still to repair, or one code reported - never passes, and counts as wrong on every row of its
    // column when answers are compared: otherwise the copy (which hides the rows it copied) would beat the honest rule with those rows wrong,
    // and a reported column (not compared at all) would beat both.
    // (Completion mode: a column of the user's own rules that code once reported stays theirs, and counts against no answer.)
    const copied = overfit.length + rules.unsupported.filter((u) => u.reasonCode === OVERFIT_REASON && (askedHeaders === null || askedHeaders.has(u.outputColumn))).length;
    return {
      masked,
      rules,
      verification,
      fixedProblems,
      sendFixed,
      passes: passes(verification, rules, fixedProblems) && copied === 0,
      wrongRows: b.rows,
      wrong: wrongCount(b.rows, b.layout) + fixedProblems.length + copied * copyWeight,
      fill,
      alternatives: results,
      overfit,
      source: { answer, alternatives },
      ms: now() - started,
      // (Over the budget also when every step ran but took longer: the next answer would too.)
      overBudget: overBudget.length > 0 || now() > deadline ? overBudget : null,
    };
  };
  /**
   * What a round tells the AI step besides the rows: the fixed lock's findings, then the row count and layout rows (not the diffs: the loop
   * picks those). Every value in them is masked like the samples (SPEC 7.2): the layout rows by the verification's masker, the lock on the
   * masked side.
   */
  const otherProblems = (j: Judged): RepairProblem[] => [...j.sendFixed.slice(0, MAX_FIXED_PROBLEMS), ...j.verification.repairProblems.filter((p) => p.kind !== 'diff'), ...j.overfit];

  const first = judge(learned.rules, learned.alternatives);
  // DECISION (an honest unsupported is not a mismatch, with one exception): a column the answer gives up on although the pair analysis found how
  // it is built (the payload carries a hint for it) is a problem for the first round - one call to write the rule. It is that round's trigger
  // and no more: a model that stands by "unsupported" after it is accepted (the column stays "needs your input"). (Asked of the answer as it
  // wrote it: the messages name its columns in the payload's own vocabulary.)
  const evidence = unsupportedDespiteEvidence(first.masked, payload);
  stages.verifiedFirstCall = first.passes && evidence.length === 0;

  // ---- SPEC 5 A step 6 / 9.3: the learning loop (`learn/loop.ts`) - rounds of browser-triggered repairs, each with the rows still wrong ----
  // (Nothing to say to the AI step when there is no problem to name: an answer that produced no column at all is no verified learn, but
  // there is nothing in the example it differs from - the API's own checks already asked for more.)
  const caps = opts.callRepair ? loopCaps() : { ...loopCaps(), maxRounds: 0 };
  const loopCtx = { analysis, payload, masker, caps };
  const answers: (Judged | null)[] = [first];
  let loop = startLoop([...built.sampleRows.map((s) => s.in), ...built.droppedRows], checkRows);
  let decided = loopStep(
    loop,
    { rules: true, passes: stages.verifiedFirstCall, wrong: first.wrong + evidence.length, wrongRows: first.wrongRows, otherProblems: [...otherProblems(first), ...evidence] },
    loopCtx,
  );
  loop = decided.state;
  // Engine audit (2026-10-07): an answer past the time budget ends the learn there - the next one would take as long (`limits.learn.judge`).
  const overBudget = (j: Judged | null): boolean => j !== null && j.overBudget !== null;
  const budget = { hit: overBudget(first), skipped: new Set<TimeBudgetSummary['skipped'][number]>(first.overBudget ?? []), ms: first.ms };
  /** The round the loop planned and the time budget stopped: not made, so neither it nor its rows are counted. */
  const unmade = { rounds: 0, rows: 0 };
  while (decided.step.kind === 'next' && opts.callRepair) {
    if (budget.hit) {
      budget.skipped.add('rounds');
      unmade.rounds = 1;
      unmade.rows = decided.step.rows.length + decided.step.namedOnly.length;
      break;
    }
    const step = decided.step;
    stages.browserRepairUsed = true;
    const previous = answers[loop.best]!;
    // A round that carries an `overfit` problem is the learn's one repair for it: its answer, and every one after, falls back.
    if (step.problems.some((p) => p.kind === 'overfit')) overfitRepaired = true;
    const repaired = await opts.callRepair(payload, previous.masked, step.problems, { round: step.round, maxRounds: caps.maxRounds, rows: loop.sent.map((r) => r.sample), newRows: step.rows.length + step.namedOnly.length, overfitRepaired });
    calls.push(...repaired.calls);
    if (repaired.overfitRepaired) overfitRepaired = true;
    const judged = repaired.rules ? judge(repaired.rules, repaired.alternatives) : null;
    answers.push(judged);
    if (judged) {
      budget.ms = Math.max(budget.ms, judged.ms);
      if (overBudget(judged)) {
        budget.hit = true;
        for (const s of judged.overBudget ?? []) budget.skipped.add(s);
      }
    }
    decided = loopStep(
      loop,
      judged
        ? { rules: true, passes: judged.passes, wrong: judged.wrong, wrongRows: judged.wrongRows, otherProblems: otherProblems(judged) }
        : { rules: false, passes: false, wrong: Number.POSITIVE_INFINITY, wrongRows: [], otherProblems: [] },
      loopCtx,
    );
    loop = decided.state;
  }
  // The answer kept is the loop's best (the fewest wrong rows; ties keep the earliest). One that still has a rule that copies rows - no round
  // could repair it - is judged again with the honest fallback: never counted as verified by a copy of the example.
  const best = answers[loop.best] ?? first;
  let kept = best.overfit.length > 0 ? judge(best.source.answer, best.source.alternatives, true) : best;

  // ---- Logic first (docs/proposals/saved-format-contents.md section 4): the kept answer's list columns get ONE automatic round, a round of
  // the loop (its caps, the API's repair calls), never more than one per learn. (Completion mode: the asked columns only, never a list of the
  // user's own rules.) ----
  const listOpts: OneTimeOptions = askedHeaders && complete ? { columns: askedHeaders, fixed: complete.fixedRules } : {};
  let listRetry: ListRetrySummary | undefined;
  let retryCalls = 0;
  const lists = opts.callRepair && loop.rounds < caps.maxRounds ? copiedLists(kept.rules, analysis, listOpts) : [];
  // (Past the time budget the list's round is not made either: it is one more answer to judge. The list is still asked about at Save.)
  if (budget.hit && lists.length > 0) budget.skipped.add('listRound');
  if (opts.callRepair && lists.length > 0 && !budget.hit) {
    // (one per list column - within the server's cap on a round's problems, `limits.learn.loop.maxProblems`, kept here all the same)
    const problems = listRetryProblems(lists, kept.masked).slice(0, limits.learn.loop.maxProblems);
    const rows = loop.sent.map((r) => r.sample);
    const base: LoopRound = { round: loop.rounds + 1, maxRounds: caps.maxRounds, rows, newRows: 0, overfitRepaired, list: true };
    stages.browserRepairUsed = true;
    let repaired = await opts.callRepair(payload, kept.masked, problems, base);
    retryCalls = 1;
    calls.push(...repaired.calls);
    // learn-v9: the AI step may prove its point with checks first ("a band on the total fits", "every key always gives one value"), answered
    // on every row like the learn's own (`nextCheckRound`) - each answer is one more call of the round, within the loop's caps.
    const retryRounds: CheckRound[] = [];
    while (repaired.checks && !repaired.rules && retryRounds.length < limits.learn.checks.maxRounds && loop.rounds + retryCalls < caps.maxRounds) {
      const next = nextCheckRound(repaired.checks, repaired.droppedChecks ?? [], {
        analysis,
        masker,
        fixedRules: complete?.fixedRules,
        payload: withRows(payload, rows),
        rounds: retryRounds,
        sent: new Set([...built.sampleRows.map((r) => r.in), ...built.droppedRows, ...checkRows, ...loop.sent.map((r) => r.inRow), ...loop.named]),
        rowBudget: limits.learn.loop.maxRowsTotal - payloadRowCount(payload) - checkRows.length - loop.sent.length - loop.named.length,
      });
      if (!next) break;
      retryRounds.push(next.round);
      checkRows.push(...next.rowsShown);
      repaired = await opts.callRepair(payload, kept.masked, problems, { ...base, round: base.round + retryCalls, checks: [...retryRounds] });
      retryCalls += 1;
      calls.push(...repaired.calls);
    }
    if (repaired.overfitRepaired) overfitRepaired = true;
    // Code checks the answer on every row, as always: it replaces the kept one only when it is no worse (ties: a passing one over one that
    // does not pass). An answer that still copies rows is judged with the honest fallback, like the loop's kept answer.
    const judged = repaired.rules ? judge(repaired.rules, repaired.alternatives) : null;
    const candidate = judged && judged.overfit.length > 0 ? judge(judged.source.answer, judged.source.alternatives, true) : judged;
    const columns = lists.map((q) => q.header);
    let outcome: ListRetrySummary['outcome'] = 'noAnswer';
    if (candidate) {
      const noWorse = candidate.wrong < kept.wrong || (candidate.wrong === kept.wrong && (candidate.passes || !kept.passes));
      if (!noWorse) outcome = 'worse';
      else {
        kept = candidate;
        const still = new Set(copiedLists(kept.rules, analysis, listOpts).map((q) => q.header));
        outcome = columns.some((h) => still.has(h)) ? 'kept' : 'logic';
      }
    }
    listRetry = { columns, calls: retryCalls, checkRounds: retryRounds.length, outcome };
  }

  const { rules, fixedProblems } = kept;
  // (The wrong rows were the loop's to choose from; they hold real values and stay here.)
  const { wrongRows: _wrongRows, ...verification } = kept.verification;
  stages.verifiedAfterRepair = kept.passes;
  const loopSummary: LoopSummary = {
    rounds: loop.rounds - unmade.rounds + retryCalls,
    rowsSent: loop.sent.length + loop.named.length - unmade.rows,
    end: budget.skipped.has('rounds') ? 'timeBudget' : decided.step.kind === 'stop' ? decided.step.reason : 'verified',
  };
  const timeBudget: TimeBudgetSummary | undefined = budget.hit ? { budgetMs: judgeBudgetMs, answerMs: budget.ms, skipped: (['fill', 'alternatives', 'rounds', 'listRound'] as const).filter((s) => budget.skipped.has(s)) } : undefined;

  // A one-time edit or a rule? (SPEC 21 v12 item 20): the parts of the kept answer that explain one row of the example only, for the user -
  // and (owner amendment, 2026-10-06; docs/proposals/saved-format-contents.md section 3) the lists of fixed values the kept answer still has,
  // asked at Save. Completion mode: the asked columns only, never a lookup or a value map of the user's own rules.
  const oneTimers = oneTimeQuestions(rules, analysis, listOpts);

  // learn-v7: the notes leave the rules here (SPEC 15): the answer the caller works with has none, and they travel beside it.
  const aiNotes = aiNotesOf(rules);
  const stripped = stripAiNotes(rules);
  // Completion mode: the user's own code checks come back (they were never sent).
  const restored = userCodeChecks.filter((v) => !stripped.validations.some((w) => deepEqual(v, w)));
  const answer = restored.length > 0 ? { ...stripped, validations: [...stripped.validations, ...restored] } : stripped;

  return {
    path: 'llm',
    preflight: pf,
    rules: answer,
    verification,
    assumptions: answer.assumptions,
    unsupported: answer.unsupported,
    calls,
    stages,
    readiness: shownReadiness,
    loop: loopSummary,
    ...(listRetry ? { listRetry } : {}),
    ...checkSummary,
    filled: kept.fill.summary,
    ...(kept.fill.ambiguities.length > 0 ? { ambiguities: kept.fill.ambiguities } : {}),
    ...(kept.alternatives.length > 0 ? { alternatives: kept.alternatives } : {}),
    ...(oneTimers.questions.length > 0 || oneTimers.handedOff.length > 0 ? { oneTimers } : {}),
    ...(aiNotes.length > 0 ? { aiNotes } : {}),
    ...(timeBudget ? { timeBudget } : {}),
    ...(complete ? { completion: { columns: [...complete.columns], parts: [...complete.parts], fixedProblems, matches: matchesExample(kept.verification, rules), produced: completionProduced(rules, complete.fixedRules, complete) } } : {}),
  };
}

/** What `nextCheckRound` needs: the example, the masker, the user's rules (completion), the step so far and the rows sent. */
interface NextRoundContext {
  analysis: PairAnalysis;
  masker: Masker | undefined;
  fixedRules: LearnResult | Rules | undefined;
  payload: LearnPayload;
  rounds: readonly CheckRound[];
  sent: ReadonlySet<number>;
  rowBudget: number;
}

/**
 * The next round of checks: code's answers (`answerChecks`), and the lines the API sent for what it dropped. DECISION: the step must fit the
 * payload byte cap with every round (the API refuses it otherwise, `stepFits`), so a round too large is sent with counts only (its rows
 * withheld, and not counted), then - still too large - with an error for each check; null when even that does not fit.
 */
function nextCheckRound(checks: Check[], dropped: string[], ctx: NextRoundContext): { round: CheckRound; rowsShown: number[] } | null {
  const answered = answerChecks(checks, { analysis: ctx.analysis, masker: ctx.masker, fixedRules: ctx.fixedRules, sent: ctx.sent, rowBudget: ctx.rowBudget });
  const roundOf = (answers: CheckAnswer[]): CheckRound => ({ checks, answers, ...(dropped.length > 0 ? { dropped } : {}) });
  const fits = (round: CheckRound): boolean => stepBytes(ctx.payload, [...ctx.rounds, round]) <= limits.payload.maxBytes;
  const full = roundOf(answered.answers);
  if (fits(full)) return { round: full, rowsShown: answered.rowsShown };
  const countsOnly = roundOf(answered.answers.map(withoutRows));
  if (fits(countsOnly)) return { round: countsOnly, rowsShown: [] };
  const errors = roundOf(checks.map(() => ({ error: 'not sent: the answers did not fit the size limit of a request' })));
  return fits(errors) ? { round: errors, rowsShown: [] } : null;
}

function withoutCodeChecks<R extends LearnResult | Rules>(rules: R): R {
  return rules.validations.some(isCodeCheck) ? { ...rules, validations: rules.validations.filter((v) => !isCodeCheck(v)) } : rules;
}

/** The local partial result, or null when there is none. It is a preview built from what code already knows, so a
 * problem in building it must never take down a learn that would otherwise reach the AI step. */
function localPartial(analysis: PairAnalysis, pf: PreflightResult): PartialRulesResult | null {
  try {
    const p = partialRules(analysis, pf);
    return 'reason' in p ? null : p;
  } catch {
    return null;
  }
}

/** The local partial result (SPEC 21 v5 item 1): built rules for what code explained, checked against the
 * example on those columns only. */
function partialResult<Call>(
  analysis: PairAnalysis,
  pf: PreflightResult,
  partial: PartialRulesResult,
  readiness: AiReadiness,
  stages: LearnStages,
): LearnFromExamplesResult<Call> {
  stages.partialBuilt = true;
  const verification = verifyAgainstExample(partial.rules, analysis, { onlyColumns: partial.solvedColumns });
  return {
    path: 'partial',
    preflight: pf,
    rules: partial.rules,
    verification,
    assumptions: partial.assumptions,
    unsupported: partial.rules.unsupported,
    calls: [],
    stages,
    partial: {
      reason: 'aiNotAllowed',
      solved: partial.solved,
      needsAi: partial.needsAi,
      external: partial.external,
      solvedColumns: partial.solvedColumns,
      needsAiParts: partial.needsAiParts,
    },
    readiness,
  };
}
