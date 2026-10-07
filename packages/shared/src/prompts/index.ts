// The system prompts the code can send, by version (LEARN_PROMPT.md; `config/prompts.ts`). Each version is sent with the wire schema it was
// written for and has its own repair instruction (`./repair.ts`): learn-v7 the rules schema (`learnResultWireJsonSchema`); learn-v9 (AI code
// checks) another schema altogether, `{ checks, rules }` for every call of the learn (`learnStepWireJsonSchema`), its rules learn-v7's.
import { promptVersion, type PromptVersion } from '../config/prompts';
import { LEARN_SYSTEM_PROMPT_V7 } from './learnV7';
import { LEARN_SYSTEM_PROMPT_V9 } from './learnV9';
import { REPAIR_INSTRUCTION_V7, REPAIR_INSTRUCTION_V9 } from './repair';

export { LEARN_SYSTEM_PROMPT_V7 } from './learnV7';
export { LEARN_SYSTEM_PROMPT_V9 } from './learnV9';
export { REPAIR_INSTRUCTION_V7, REPAIR_INSTRUCTION_V9, RULES_NOW_INSTRUCTION_V9 } from './repair';

export interface LearnPrompt {
  version: PromptVersion;
  /** The system prompt, verbatim. */
  system: string;
  /** The fix-only instruction appended to a repair block (LEARN_PROMPT §4). */
  repair: string;
  /**
   * learn-v9: the AI step may answer with checks instead of the rules (`checks.ts`), and every call of the learn is sent the step schema
   * (`learnStepWireJsonSchema`). Absent on learn-v7.
   */
  checks?: true;
}

const PROMPTS: Record<PromptVersion, LearnPrompt> = {
  'learn-v7': { version: 'learn-v7', system: LEARN_SYSTEM_PROMPT_V7, repair: REPAIR_INSTRUCTION_V7 },
  // learn-v9 = learn-v7 + "Checking with code": learn-v7's rules and repair instruction, plus "answer with the rules".
  'learn-v9': { version: 'learn-v9', system: LEARN_SYSTEM_PROMPT_V9, repair: REPAIR_INSTRUCTION_V9, checks: true },
};

/** The prompt of a version (default: the current one, `promptVersion`). */
export function learnPromptOf(version: PromptVersion = promptVersion): LearnPrompt {
  return PROMPTS[version];
}

/** The current system prompt (`promptVersion`). */
export const LEARN_SYSTEM_PROMPT = PROMPTS[promptVersion].system;

/** The current repair instruction (`promptVersion`), appended to the repair user content (LEARN_PROMPT §4). */
export const REPAIR_INSTRUCTION = PROMPTS[promptVersion].repair;
