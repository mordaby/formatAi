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

