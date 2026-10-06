// The fix-only instruction appended to every repair block (LEARN_PROMPT §4), by prompt version. It goes in the repair user content, never in
// the system prompt, so the cached prefix still hits. Each version keeps its own, so `--prompt learn-v7` is the learn-v7 of before: a
// comparison of two prompts compares their repair instructions too.

/** learn-v7 (and every version before it). */
export const REPAIR_INSTRUCTION_V7 = 'Fix only what the problems require. Keep everything else identical.';

/**
 * learn-v9 (AI code checks): learn-v7's instruction, and that a repair answers with the rules. Every call of a learn-v9 learn is sent the
 * one step schema (`{ checks, rules }`: one schema keeps the prompt cache working across the calls), so the schema alone would let a repair
 * ask checks; checks are for the learn's own steps only, and a repair that asks them anyway is a schema problem.
 */
export const REPAIR_INSTRUCTION_V9 = `${REPAIR_INSTRUCTION_V7} Answer with the rules ("checks": null).`;

/** learn-v9: the instruction block after the last round of checks, and of every call of the learn that must answer with the rules (the escalation). */
export const RULES_NOW_INSTRUCTION_V9 = 'No more checks: answer with the rules now ("checks": null, "rules": the rules file).';

/**
 * learn-v8 (prompt audit F11): inside the learning loop a repair carries rows of the example the model never saw, round after round, and
 * the narrowest fix for "this row: expected A, got B" is a condition on that row's own values - the overfitting nothing else in a repair
 * guards against. The middle sentence says what a problem's row holds (X1: `out` is always the example's own output, `made` a row the rules
 * made that the example does not have).
 */
export const REPAIR_INSTRUCTION_V8 =
  'Fix only what the problems require; keep everything else identical. ' +
  'A row in a problem is a row of the same example, masked like the samples ("out" is its output in the example, [] when it has none; "made" is a row your rules made that the example does not have): ' +
  "change the rule so that it fits that row and every sample, never add a condition on one row's own values.";

/**
 * learn-v8's E1 sentence for the repair (prompt audit F11/F15), with the system prompt's E1 line: the rows a loop round sends are wrong
 * AFTER code filled the data from every row. DECISION: the audit's text as written. The API's own check of a repair answer runs it as
 * written (no fill: `fillParams` runs in the browser and the eval only), so a row there can still lack an entry - the system prompt's "include
 * every pair seen in samples and hints" covers that, and the browser fills before it decides.
 */
export const REPAIR_INSTRUCTION_E1 =
  'Code completes value map and lookup entries and thresholds from every row before it checks, so a wrong row means the logic is wrong, not that an entry is missing.';
