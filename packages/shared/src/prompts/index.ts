// The system prompts the code can send, by version (LEARN_PROMPT.md; `config/prompts.ts`). Each version is sent with the wire schema it was
// written for: learn-v8 added the optional `alternatives` (`learnResultWireJsonSchema({ alternatives })`); learn-v7 never saw it. And each
// has its own repair instruction (`./repair.ts`). learn-v9 (AI code checks) is sent another schema altogether: `{ checks, rules }` for every call of
// the learn (`learnStepWireJsonSchema`), its rules learn-v7's (no `alternatives`).
import { promptVersion, type PromptVersion } from '../config/prompts';
import { LEARN_SYSTEM_PROMPT_V7 } from './learnV7';
import { LEARN_SYSTEM_PROMPT_V8, LEARN_SYSTEM_PROMPT_V8_NO_E1 } from './learnV8';
import { LEARN_SYSTEM_PROMPT_V8_1, LEARN_SYSTEM_PROMPT_V8_1_NO_E1 } from './learnV81';
import { LEARN_SYSTEM_PROMPT_V9 } from './learnV9';
import { REPAIR_INSTRUCTION_E1, REPAIR_INSTRUCTION_V7, REPAIR_INSTRUCTION_V8, REPAIR_INSTRUCTION_V9 } from './repair';

export { LEARN_SYSTEM_PROMPT_V7 } from './learnV7';
export { LEARN_SYSTEM_PROMPT_V8, LEARN_SYSTEM_PROMPT_V8_NO_E1 } from './learnV8';
export { LEARN_SYSTEM_PROMPT_V8_1, LEARN_SYSTEM_PROMPT_V8_1_NO_E1 } from './learnV81';
export { LEARN_SYSTEM_PROMPT_V9 } from './learnV9';
export { REPAIR_INSTRUCTION_E1, REPAIR_INSTRUCTION_V7, REPAIR_INSTRUCTION_V8, REPAIR_INSTRUCTION_V9, RULES_NOW_INSTRUCTION_V9 } from './repair';

export interface LearnPrompt {
  version: PromptVersion;
  /** The system prompt, verbatim. */
  system: string;
  /** Whether the answer may give `alternatives` (and the wire schema offers them). */
  alternatives: boolean;
  /** The fix-only instruction appended to a repair block (LEARN_PROMPT §4). */
  repair: string;
  /**
   * learn-v9: the AI step may answer with checks instead of the rules (`checks.ts`), and every call of the learn is sent the step schema
   * (`learnStepWireJsonSchema`). Absent on every older version.
   */
  checks?: true;
}

const PROMPTS: Record<PromptVersion, LearnPrompt> = {
  'learn-v7': { version: 'learn-v7', system: LEARN_SYSTEM_PROMPT_V7, alternatives: false, repair: REPAIR_INSTRUCTION_V7 },
  'learn-v8': { version: 'learn-v8', system: LEARN_SYSTEM_PROMPT_V8, alternatives: true, repair: `${REPAIR_INSTRUCTION_V8} ${REPAIR_INSTRUCTION_E1}` },
  // The eval's arm B: learn-v8 without its E1 line (`scripts/sync-prompt.ts`) and without the repair's E1 sentence, same schema.
  'learn-v8-noE1': { version: 'learn-v8-noE1', system: LEARN_SYSTEM_PROMPT_V8_NO_E1, alternatives: true, repair: REPAIR_INSTRUCTION_V8 },
  // learn-v8.1 (LEARN_PROMPT.md "learn-v8.1 changes from learn-v8"): the system prompt changed; the schema and the repair instruction are learn-v8's.
  'learn-v8.1': { version: 'learn-v8.1', system: LEARN_SYSTEM_PROMPT_V8_1, alternatives: true, repair: `${REPAIR_INSTRUCTION_V8} ${REPAIR_INSTRUCTION_E1}` },
  'learn-v8.1-noE1': { version: 'learn-v8.1-noE1', system: LEARN_SYSTEM_PROMPT_V8_1_NO_E1, alternatives: true, repair: REPAIR_INSTRUCTION_V8 },
  // learn-v9 = learn-v7 + "Checking with code": learn-v7's rules (no alternatives) and repair instruction, plus "answer with the rules".
  'learn-v9': { version: 'learn-v9', system: LEARN_SYSTEM_PROMPT_V9, alternatives: false, repair: REPAIR_INSTRUCTION_V9, checks: true },
};

/** The prompt of a version (default: the current one, `promptVersion`). */
export function learnPromptOf(version: PromptVersion = promptVersion): LearnPrompt {
  return PROMPTS[version];
}

/** The current system prompt (`promptVersion`). */
export const LEARN_SYSTEM_PROMPT = PROMPTS[promptVersion].system;

/** The current repair instruction (`promptVersion`), appended to the repair user content (LEARN_PROMPT §4). */
export const REPAIR_INSTRUCTION = PROMPTS[promptVersion].repair;
