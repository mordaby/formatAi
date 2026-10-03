export { runRules, SUPPORTED_SCHEMA_VERSIONS } from './runRules';
export type { RunRulesOptions } from './runRules';
export { FLAG_MESSAGE_KEYS } from './v1/messageKeys';
export type { FlagMessageKey } from './v1/messageKeys';
// The header mapping a run uses (exact, then alias, then normalized): the browser needs it to show a flagged row's
// input values by the column that reads them (SPEC 21 v5 item 5, the "fix this row only" editor).
export { mapHeaders } from './v1/normalize';
