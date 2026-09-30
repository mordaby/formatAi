// The typed surface of the engine worker: method arguments/results, progress events
// and the host functions the worker may call back into. Types only - imported by both
// the worker (engineMethods.ts) and the main-thread client (engineClient.ts).
import type { Format, LearnPayload, LearnResult, RepairProblem, Rules, Tier } from '@formatai/shared';
import type {
  AnalysisStage,
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
  LiveCheckArgs,
  LiveCheckResult,
  LoadExampleArgs,
  LoadExampleOutput,
  StaticChecksArgs,
  StaticProblem,
} from './editorApi';

export type * from './editorApi';

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
}

/** Real progress from the worker. `reading` runs until the first analysis event; `learning`/`verifying` only happen on the LLM path. */
export type LearnProgress =
  | { phase: 'reading' }
  | { phase: 'checking'; stage: AnalysisStage; fraction: number }
  | { phase: 'learning'; attempt: 'learn' | 'repair' }
  | { phase: 'verifying' };

/** `exampleId`: set when the worker kept the example (the rules editor's live check reads it, SPEC 8.11). */
export type LearnOutput = LearnFromExamplesResult & { exampleId?: string };

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
}
export type EngineMethodName = keyof EngineMethodMap;
