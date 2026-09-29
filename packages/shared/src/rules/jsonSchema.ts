// JSON Schema export for the LLM's structured-output call (SPEC 9.1, LEARN_PROMPT §5).
import { z } from 'zod';
import { LearnResultSchema } from './schema';

/**
 * The LearnResult JSON Schema (draft 2020-12) generated from the zod schema.
 * Every fixed-shape object is additionalProperties: false; the few genuine open
 * dictionaries (valueMaps.map, expand.columnsToRows.labels, fixedFanOut set) use
 * a typed `additionalProperties` schema instead, since they take arbitrary keys
 * drawn from the user's own data.
 */
export function learnResultJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(LearnResultSchema) as Record<string, unknown>;
}
