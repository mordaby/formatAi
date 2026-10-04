// Public surface of the learn orchestration (SPEC 5 A, 9). Exposed as
// `@formatai/api/learn` (see package.json "exports") for the routes and for tests.
export { buildSampleInputTable, runOnSamples } from './sampleRun.js';
export { readCompleteFixed, runChecks, type ChecksOptions, type ChecksResult } from './checks.js';
export { overfitLint } from './overfitLint.js';
export {
  dropInvalidNotes,
  hashOwner,
  payloadValues,
  recordFunctionRequests,
  requestCounterKey,
  requestKey,
  requestKeysOf,
  requestMentionsPayloadValue,
  topicOfRequest,
  type NotesContext,
  type NotesOutcome,
  type PayloadValues,
} from './notes.js';
export {
  countProblems,
  learn,
  repairFromBrowser,
  type CompleteFn,
  type LearnOptions,
  type LearnOutcome,
  type LlmCallRecord,
  type RepairOptions,
} from './learn.js';
