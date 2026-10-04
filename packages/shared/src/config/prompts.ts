// SPEC 9.1 / LEARN_PROMPT.md: "The prompt text is versioned (promptVersion) and
// logged with every call." Bump this whenever LEARN_PROMPT.md's system prompt
// changes, and re-run the eval harness (SPEC 10 "Regression").

/** The prompt versions the code can still send: the current one, and the one before it, kept for the eval's `--prompt` comparison. */
export const PROMPT_VERSIONS = ['learn-v7', 'learn-v8'] as const;
export type PromptVersion = (typeof PROMPT_VERSIONS)[number];

/** The version every learn sends (the eval may pick another with `--prompt`). */
export const promptVersion: PromptVersion = 'learn-v8';

export function isPromptVersion(v: string): v is PromptVersion {
  return (PROMPT_VERSIONS as readonly string[]).includes(v);
}
