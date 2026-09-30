// Public surface of the learn orchestration (SPEC 5 A, 9). Exposed as
// `@formatai/api/learn` (see package.json "exports") for the routes and for tests.
export { buildSampleInputTable, runOnSamples } from './sampleRun.js';
export { runChecks, type ChecksOptions, type ChecksResult } from './checks.js';
export { overfitLint } from './overfitLint.js';
export {
  countProblems,
  learn,
  repairFromBrowser,
  type CompleteFn,
  type LearnOptions,
  type LearnOutcome,
  type LlmCallRecord,
} from './learn.js';
