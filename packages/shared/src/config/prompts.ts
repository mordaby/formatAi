// SPEC 9.1 / LEARN_PROMPT.md: "The prompt text is versioned (promptVersion) and
// logged with every call." Bump this whenever LEARN_PROMPT.md's system prompt
// changes, and re-run the eval harness (SPEC 10 "Regression").

/**
 * The prompt versions the code can send (the eval's `--prompt` compares them on the same code): learn-v7 (the default, below) and learn-v9.
 * learn-v8, learn-v8.1 and their "-noE1" variants (the prompt audit's, docs/proposals/prompt-audit-learn-v7.md) were measured against
 * learn-v7 and rejected (2026-10-05), and their code was removed (2026-10-07; docs/spec-history.md, 2026-10-07 "learn-v8 removed"). A rules
 * file or ledger entry that names one still reads: `promptVersion` is stored as plain text.
 *
 * learn-v9 (docs/proposals/ai-code-checks.md, owner decision 2026-10-05): learn-v7 plus one section, "Checking with code" - the AI step may
 * ask code a few closed, typed questions about the whole example before it answers (`checks.ts`). It is sent only where it is asked for:
 * the eval's `--prompt learn-v9`, and in the app the learns `LEARN_CHECKS` gives it to (`limits.learn.checks.mode`: off, admin, all).
 */
export const PROMPT_VERSIONS = ['learn-v7', 'learn-v9'] as const;
export type PromptVersion = (typeof PROMPT_VERSIONS)[number];

/**
 * The version every learn sends (the eval may pick another with `--prompt`).
 *
 * DECISION (2026-10-05): back to learn-v7. The eval of learn-v8 against it (26 cases, both modes) showed learn-v8 fitting every row at any
 * cost - a position condition for one hand-edited row, a long case list for a column whose values come from elsewhere, counted as verified
 * - so the default stays the measured learn-v7 until a later version beats it on the eval.
 */
export const promptVersion: PromptVersion = 'learn-v7';

export function isPromptVersion(v: string): v is PromptVersion {
  return (PROMPT_VERSIONS as readonly string[]).includes(v);
}
