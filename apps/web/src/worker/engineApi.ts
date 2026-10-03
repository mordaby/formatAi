// The typed surface of the engine worker: method arguments/results, progress events
// and the host functions the worker may call back into. Types only - imported by both
// the worker (engineMethods.ts) and the main-thread client (engineClient.ts).
import type { Format, LearnPayload, LearnResult, RepairProblem, Rules, Tier } from '@formatai/shared';
import type {
  AnalysisStage,
  CompleteOptions,
  ConvertResult,
  Flag,
  LearnCallResult,
  LearnFromExamplesResult,
  OutputSheet,
  RunError,
  RunSummary,
  VerifyResult,
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
}

/** Real progress from the worker. `reading` runs until the first analysis event; `learning`/`verifying` only happen on the LLM path. */
export type LearnProgress =
  | { phase: 'reading' }
  | { phase: 'checking'; stage: AnalysisStage; fraction: number }
  /** `unexplained`: headers of the output columns code could not find in the input file (SPEC 6.4, informational: the AI step tries them); first try only. */
  | { phase: 'learning'; attempt: 'learn' | 'repair'; unexplained?: string[] }
  | { phase: 'verifying' };

/**
 * `exampleId`: set when the worker kept the example (the rules editor's live check reads it, SPEC 8.11).
 * `exampleInput`: the example input's columns (headers and profile facts, no values), so the editor can offer the ones no rule uses yet.
 * `exampleOutputColumns`: how many columns the example OUTPUT has - completion mode needs the rules' output columns to line up with them.
 */
export type LearnOutput = LearnFromExamplesResult & { exampleId?: string; exampleInput?: ExampleInputColumn[]; exampleOutputColumns?: number };

/** What the main thread does on the worker's behalf (the HTTP calls; the worker has no network code). */
export interface LearnHost {
  callLearn(payload: LearnPayload): Promise<LearnCallResult>;
  callRepair(payload: LearnPayload, previousRules: LearnResult, problems: RepairProblem[]): Promise<LearnCallResult>;
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

// ---------- verify ----------

export interface VerifyArgs {
  input: FileBytes;
  output: FileBytes;
  rules: LearnResult | Rules;
  /** SPEC 8.11 "One-off exceptions": 1-based example row numbers marked "fixed by hand". */
  exceptions?: number[];
}

export type VerifyOutput = { ok: true; verification: VerifyResult } | { ok: false; reason: 'analysisFailed' };

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
  inspect: { args: InspectArgs; result: InspectOutput; progress: never };
  convert: { args: ConvertArgs; result: ConvertOutput; progress: never };
  verify: { args: VerifyArgs; result: VerifyOutput; progress: never };
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
