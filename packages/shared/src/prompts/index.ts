// The system prompts the code can send, by version (LEARN_PROMPT.md; `config/prompts.ts`). Each version is sent with the wire schema it was
// written for: learn-v8 added the optional `alternatives` (`learnResultWireJsonSchema({ alternatives })`); learn-v7 never saw it.
import { promptVersion, type PromptVersion } from '../config/prompts';
import { LEARN_SYSTEM_PROMPT_V7 } from './learnV7';
import { LEARN_SYSTEM_PROMPT_V8, LEARN_SYSTEM_PROMPT_V8_NO_E1 } from './learnV8';

export { LEARN_SYSTEM_PROMPT_V7 } from './learnV7';
export { LEARN_SYSTEM_PROMPT_V8, LEARN_SYSTEM_PROMPT_V8_NO_E1 } from './learnV8';

export interface LearnPrompt {
  version: PromptVersion;
  /** The system prompt, verbatim. */
  system: string;
  /** Whether the answer may give `alternatives` (and the wire schema offers them). */
  alternatives: boolean;
}

const PROMPTS: Record<PromptVersion, LearnPrompt> = {
  'learn-v7': { version: 'learn-v7', system: LEARN_SYSTEM_PROMPT_V7, alternatives: false },
  'learn-v8': { version: 'learn-v8', system: LEARN_SYSTEM_PROMPT_V8, alternatives: true },
  // The eval's arm B: learn-v8 without its E1 line (`scripts/sync-prompt.ts`), same schema.
  'learn-v8-noE1': { version: 'learn-v8-noE1', system: LEARN_SYSTEM_PROMPT_V8_NO_E1, alternatives: true },
};

/** The prompt of a version (default: the current one, `promptVersion`). */
export function learnPromptOf(version: PromptVersion = promptVersion): LearnPrompt {
  return PROMPTS[version];
}

/** The current system prompt (`promptVersion`). */
export const LEARN_SYSTEM_PROMPT = PROMPTS[promptVersion].system;
