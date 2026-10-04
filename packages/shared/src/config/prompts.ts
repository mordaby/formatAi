// SPEC 9.1 / LEARN_PROMPT.md: "The prompt text is versioned (promptVersion) and
// logged with every call." Bump this whenever LEARN_PROMPT.md's system prompt
// changes, and re-run the eval harness (SPEC 10 "Regression").

/**
 * The prompt versions the code can still send: the current one, the one before it (kept for the eval's `--prompt` comparison), and
 * learn-v8-noE1 - learn-v8 without its one "E1" line (code completes the data parts of the rules from every row), the prompt audit's
 * arm B (docs/proposals/prompt-audit-learn-v7.md section 5).
 *
 * DECISION: the E1 switch is a prompt version of its own, made at build time from the same LEARN_PROMPT.md block
 * (`scripts/sync-prompt.ts`), not a flag on learn-v8: every call logs `promptVersion`, and the structure cache and the ledger tell two
 * texts apart by it alone - a flag beside the version would make one version name two prompts. Only the eval sends learn-v8-noE1.
 */
export const PROMPT_VERSIONS = ['learn-v7', 'learn-v8', 'learn-v8-noE1'] as const;
export type PromptVersion = (typeof PROMPT_VERSIONS)[number];

/** The version every learn sends (the eval may pick another with `--prompt`). */
export const promptVersion: PromptVersion = 'learn-v8';

export function isPromptVersion(v: string): v is PromptVersion {
  return (PROMPT_VERSIONS as readonly string[]).includes(v);
}
