// SPEC 9.1 / LEARN_PROMPT.md: "The prompt text is versioned (promptVersion) and
// logged with every call." Bump this whenever LEARN_PROMPT.md's system prompt
// changes, and re-run the eval harness (SPEC 10 "Regression").

/**
 * The prompt versions the code can still send (the eval's `--prompt` compares them on the same code): learn-v7 (the default, below),
 * learn-v8 (the prompt audit's), learn-v8.1 (learn-v8 with the audit's F10 edits returned to learn-v7's meaning and one sentence on the
 * two shapes of copying rows - LEARN_PROMPT.md's newest block), and for each of the last two its "-noE1" variant: the same text without
 * its one "E1" line (code completes the data parts of the rules from every row), the prompt audit's arm B
 * (docs/proposals/prompt-audit-learn-v7.md section 5).
 *
 * DECISION: the E1 switch is a prompt version of its own, made at build time from the same LEARN_PROMPT.md block
 * (`scripts/sync-prompt.ts`), not a flag: every call logs `promptVersion`, and the structure cache and the ledger tell two texts apart
 * by it alone - a flag beside the version would make one version name two prompts. Only the eval sends the noE1 variants.
 */
export const PROMPT_VERSIONS = ['learn-v7', 'learn-v8', 'learn-v8-noE1', 'learn-v8.1', 'learn-v8.1-noE1'] as const;
export type PromptVersion = (typeof PROMPT_VERSIONS)[number];

/**
 * The version every learn sends (the eval may pick another with `--prompt`).
 *
 * DECISION (2026-10-05): back to learn-v7. The eval of learn-v8 against it (26 cases, both modes) showed learn-v8 fitting every row at any
 * cost - a position condition for one hand-edited row, a long case list for a column whose values come from elsewhere, counted as verified
 * - so the default stays the measured learn-v7 until a later version beats it on the eval. learn-v8 stays selectable for the comparison.
 */
export const promptVersion: PromptVersion = 'learn-v7';

export function isPromptVersion(v: string): v is PromptVersion {
  return (PROMPT_VERSIONS as readonly string[]).includes(v);
}
