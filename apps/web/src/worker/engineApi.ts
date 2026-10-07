// The typed surface of the engine worker: method arguments/results, progress events
// and the host functions the worker may call back into. Types only - imported by both
// the worker (engineMethods.ts) and the main-thread client (engineClient.ts).
import type { CheckRound, Format, LearnPayload, LearnResult, RepairProblem, Rules, Tier } from '@formatai/shared';
import type {
  AmbiguousColumn,
  AnalysisStage,
  CompleteOptions,
  ConvertResult,
  Flag,
  LearnCallResult,
  LearnFromExamplesResult,
  LoopRound,
  OutputSheet,
  RunError,
  RunSummary,
  SendPreview,
  SentColumn,
  UserColumnChoices,
} from '@formatai/engine';
import type {
  BatchArgs,
  BatchOutput,
  ColumnGapsArgs,
  ColumnGapsOutput,
  ConvertRunArgs,
  ConvertRunOutput,
  HeadersArgs,
  HeadersOutput,
  MatchFileArgs,
  MatchFileOutput,
} from './convertApi';
import type { ExampleInputColumn } from '../editor/types';
import type {
  LiveCheckArgs,
  LiveCheckResult,
  LoadExampleArgs,
  LoadExampleOutput,
  StaticChecksArgs,
  StaticProblem,
} from './editorApi';

export type * from './editorApi';
export type * from './convertApi';

export interface FileBytes {
  name: string;
  /** Transferred to the worker (detached on the sender's side). */
  bytes: ArrayBuffer;
}

// ---------- learn ----------

export interface LearnArgs {
  input: FileBytes;
  output: FileBytes;
  /** SPEC 7.2: on by default in the UI. The key is the worker's own; it is never an argument. */
  masking: boolean;
  /** SPEC 6.4: continue past "rows couldn't be aligned". */
  tryAnyway?: boolean;
  tier: Tier;
  /** SPEC 8.12/A2: attach mode. */
  target?: Format;
  /** SPEC 21 v5 item 1: 'notAllowed' (not signed in) never calls the AI step: the local result comes back (`path: 'partial'`). Default 'allowed'. */
  ai?: 'allowed' | 'notAllowed';
  /**
   * Completion mode (LEARN_PROMPT "Completing a partial rules file"): the rules to keep and what is missing; the AI step is allowed.
   * The result has `completion` (the fixed lock's findings). The rules editor's example stays the one the screen already holds (`keepExampleId`).
   */
  complete?: CompleteOptions;
  /** Completion mode: the id of the example the Result screen's live check already uses; the worker keeps the example under it instead of a new id. */
  keepExampleId?: string;
  /** "See what we send" (owner, 2026-10-07): the user's choice per column, hidden or sent as it is - for every request of this learn. */
  columnChoices?: UserColumnChoices;
}

/** Real progress from the worker. `reading` runs until the first analysis event; `learning`/`verifying` only happen on the LLM path. */
export type LearnProgress =
  | { phase: 'reading' }
  | { phase: 'checking'; stage: AnalysisStage; fraction: number }
  /**
   * `unexplained`: headers of the output columns code could not find in the input file (SPEC 6.4, informational: the AI step tries them); first try only.
   * `round` (a repair): which round of the learning loop it is, of how many at most, and how many rows the rules got wrong it sends.
   * `checkRound` (AI code checks: the first try, or the round for a list): the AI step asked code to check ideas on every row - which round of checks it is, of how many at most.
   */
  | { phase: 'learning'; attempt: 'learn' | 'repair'; unexplained?: string[]; round?: LoopRoundInfo; checkRound?: CheckRoundInfo }
  | { phase: 'verifying' };

/** A round of the learning loop, as the progress screens say it ("round 2 of 3, sending 5 rows the rules got wrong"). */
export interface LoopRoundInfo {
  n: number;
  of: number;
  rows: number;
  /** The one round for a list of fixed values (docs/proposals/saved-format-contents.md section 4): it sends no row, it asks for the rule behind the list. */
  list?: true;
}

/**
 * A round of the AI code checks (learn-v9, SPEC 21 v14), as the progress screens say it ("The AI is checking an idea on your rows (round 1 of 3)"):
 * code answers the checks on every row, then the AI step gets the answers. `n` is the number of rounds so far (`rounds.length`), `of` the cap
 * (`limits.learn.checks.maxRounds`).
 */
export interface CheckRoundInfo {
  n: number;
  of: number;
}

/**
 * `exampleId`: set when the worker kept the example (the rules editor's live check reads it, SPEC 8.11).
 * `exampleInput`: the example input's columns (headers and profile facts, no values), so the editor can offer the ones no rule uses yet.
 * `exampleOutputColumns`: how many columns the example OUTPUT has - completion mode needs the rules' output columns to line up with them.
 * `ambiguous`: the output columns the example fits more than one rule for (a constant the input could write too) with their readings, as rule
 * fragments: the result screen asks the user once (SPEC 8.11, 21 v12 item 11). Set whatever path the learn took; absent when there are none.
 */
export type LearnOutput = LearnFromExamplesResult & {
  exampleId?: string;
  exampleInput?: ExampleInputColumn[];
  exampleOutputColumns?: number;
  ambiguous?: AmbiguousColumn[];
};

/** "See what we send" (SPEC 15): per column of the example, whether its values are hidden by masking or sent as they are (engine `sentColumns`). */
export interface SentColumns {
  input: SentColumn[];
  output: SentColumn[];
}

/**
 * What the main thread does on the worker's behalf (the HTTP calls; the worker has no network code). `columns`: the example's columns and
 * whether masking hides each one (never sent; "See what we send" shows it). `round`: the loop round of a repair (its rows go with it).
 * `callStep` (AI code checks): one step of a learn whose AI step asked checks - `rounds` is every round so far, this one last, the answers
 * masked like the samples (POST /api/learn/step).
 */
export interface LearnHost {
  callLearn(payload: LearnPayload, columns?: SentColumns): Promise<LearnCallResult>;
  callRepair(payload: LearnPayload, previousRules: LearnResult, problems: RepairProblem[], round: LoopRound): Promise<LearnCallResult>;
  callStep(payload: LearnPayload, rounds: CheckRound[]): Promise<LearnCallResult>;
}

// ---------- "See what we send" before the learn (owner, 2026-10-07) ----------

/**
 * The request the AI step would get for the two files, built in the worker by the learn's own code (engine `sendPreview`) with the
 * session's masking key - the rows shown are the rows that go. The first call reads and analyzes the files (with progress); the worker
 * keeps that analysis under `previewId`, and a switch flipped later sends the id only.
 */
export interface SendPreviewArgs {
  /** The example files: on the first call, and again when the worker no longer holds the example (`reason: 'gone'`). */
  input?: FileBytes;
  output?: FileBytes;
  /** The example the worker holds for the preview (an earlier result's `previewId`). */
  previewId?: string;
  masking: boolean;
  tier: Tier;
  choices?: UserColumnChoices;
}

export type SendPreviewOutput =
  | ({ ok: true; previewId: string } & SendPreview)
  /** `gone`: no files were given and the worker does not hold that example (it restarted, or another example came since). */
  | { ok: false; reason: 'gone' | 'analysisFailed' };

export interface SendPreviewProgress {
  stage: AnalysisStage;
  fraction: number;
}

// ---------- convert ----------

export interface ConvertArgs {
  rules: LearnResult | Rules;
  file: FileBytes;
  /** Keep only this many output rows in `preview` (the full sheet stays in the worker). */
  previewRows: number;
}

export type ConvertOutput =
  | {
      ok: true;
      /** The whole output file (xlsx/csv/txt), transferred back. */
      bytes: ArrayBuffer;
      flags: Flag[];
      summary: RunSummary;
      /** The first `previewRows` output rows, for an on-screen preview. */
      preview: OutputSheet;
      totalRows: number;
    }
  | { ok: false; error: RunError };

export type { ConvertResult };

// ---------- inspect ----------

/** A quick look at a dropped file, so the drop zone can show its size ("1,204 rows, 8 columns") before anything is learned. */
export interface InspectArgs {
  file: FileBytes;
  /** The example output is read more loosely (a report may have title rows). */
  side: 'input' | 'output';
}

export type InspectOutput =
  | { readable: false }
  /** `rows`/`columns` are null when no table was found: the pre-flight explains why when the user goes on. */
  | { readable: true; rows: number | null; columns: number | null; direction: 'rtl' | 'ltr' };

export interface EngineMethodMap {
  learn: { args: LearnArgs; result: LearnOutput; progress: LearnProgress };
  sendPreview: { args: SendPreviewArgs; result: SendPreviewOutput; progress: SendPreviewProgress };
  inspect: { args: InspectArgs; result: InspectOutput; progress: never };
  convert: { args: ConvertArgs; result: ConvertOutput; progress: never };
  loadExample: { args: LoadExampleArgs; result: LoadExampleOutput; progress: never };
  liveCheck: { args: LiveCheckArgs; result: LiveCheckResult; progress: never };
  /** Like `liveCheck`, but every row (the editor's Apply). */
  fullCheck: { args: Omit<LiveCheckArgs, 'subset'>; result: LiveCheckResult; progress: never };
  staticChecks: { args: StaticChecksArgs; result: StaticProblem[]; progress: never };
  /** Flow C/D (SPEC 5): the file's headers, matching, a run with row decisions, and the batch's zip. */
  readHeaders: { args: HeadersArgs; result: HeadersOutput; progress: never };
  matchFile: { args: MatchFileArgs; result: MatchFileOutput; progress: never };
  /** Which columns each conversion needs that the file (its headers) does not have (SPEC 8.15, 21 v11 items 4-7). */
  columnGaps: { args: ColumnGapsArgs; result: ColumnGapsOutput; progress: never };
  convertWithDecisions: { args: ConvertRunArgs; result: ConvertRunOutput; progress: never };
  batch: { args: BatchArgs; result: BatchOutput; progress: never };
}
export type EngineMethodName = keyof EngineMethodMap;
