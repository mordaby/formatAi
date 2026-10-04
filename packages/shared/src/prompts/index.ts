// The system prompts the code can send, by version (LEARN_PROMPT.md; `config/prompts.ts`). Each version is sent with the wire schema it was
// written for: learn-v8 added the optional `alternatives` (`learnResultWireJsonSchema({ alternatives })`); learn-v7 never saw it. And each
// has its own repair instruction (`./repair.ts`).
import { promptVersion, type PromptVersion } from '../config/prompts';
import { LEARN_SYSTEM_PROMPT_V7 } from './learnV7';
import { LEARN_SYSTEM_PROMPT_V8, LEARN_SYSTEM_PROMPT_V8_NO_E1 } from './learnV8';
import { REPAIR_INSTRUCTION_E1, REPAIR_INSTRUCTION_V7, REPAIR_INSTRUCTION_V8 } from './repair';

export { LEARN_SYSTEM_PROMPT_V7 } from './learnV7';
export { LEARN_SYSTEM_PROMPT_V8, LEARN_SYSTEM_PROMPT_V8_NO_E1 } from './learnV8';
export { REPAIR_INSTRUCTION_E1, REPAIR_INSTRUCTION_V7, REPAIR_INSTRUCTION_V8 } from './repair';

export interface LearnPrompt {
  version: PromptVersion;
  /** The system prompt, verbatim. */
  system: string;
  /** Whether the answer may give `alternatives` (and the wire schema offers them). */
  alternatives: boolean;
  /** The fix-only instruction appended to a repair block (LEARN_PROMPT §4). */
  repair: string;
}

const PROMPTS: Record<PromptVersion, LearnPrompt> = {
  'learn-v7': { version: 'learn-v7', system: LEARN_SYSTEM_PROMPT_V7, alternatives: false, repair: REPAIR_INSTRUCTION_V7 },
  'learn-v8': { version: 'learn-v8', system: LEARN_SYSTEM_PROMPT_V8, alternatives: true, repair: `${REPAIR_INSTRUCTION_V8} ${REPAIR_INSTRUCTION_E1}` },
  // The eval's arm B: learn-v8 without its E1 line (`scripts/sync-prompt.ts`) and without the repair's E1 sentence, same schema.
  'learn-v8-noE1': { version: 'learn-v8-noE1', system: LEARN_SYSTEM_PROMPT_V8_NO_E1, alternatives: true, repair: REPAIR_INSTRUCTION_V8 },
};

/** The prompt of a version (default: the current one, `promptVersion`). */
export function learnPromptOf(version: PromptVersion = promptVersion): LearnPrompt {
  return PROMPTS[version];
}

/** The current system prompt (`promptVersion`). */
export const LEARN_SYSTEM_PROMPT = PROMPTS[promptVersion].system;

/** The current repair instruction (`promptVersion`), appended to the repair user content (LEARN_PROMPT §4). */
export const REPAIR_INSTRUCTION = PROMPTS[promptVersion].repair;
