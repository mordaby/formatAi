// All limits live in config, never in code (SPEC non-negotiable #8).
// Sources: SPEC 2, 7.3, 9.1, 9.3, 9.5.

export const limits = {
  /** SPEC 15: the API has no endpoint that accepts files, and JSON bodies are capped at 256 KB. */
  api: {
    maxBodyBytes: 262_144,
  },
  /** SPEC 7.3: hard caps on the learn payload. */
  payload: {
    maxColumns: 60,
    maxPairs: 12,
    maxFamilies: 6,
    maxDropped: 5,
    maxCellChars: 40,
    maxBytes: 49_152,
    /** SPEC 7.3 §"Size rules": drop samples first, but never below this many pairs. */
    minPairs: 4,
  },
  /** SPEC 9.1, 9.3: LLM call settings and repair-round caps. */
  llm: {
    maxTokens: 4000,
    temperature: 0,
    /** SPEC 9.3 / 20.5. Default 1; set to 0 for exactly one LLM call per learn. */
    serverRepairRounds: 1,
    /** SPEC 9.3: at most 1 extra browser-triggered repair call after full verification. */
    browserRepairCalls: 1,
  },
  /**
   * SPEC 9.5: a daily anonymous budget and a daily overall budget, in USD.
   * DECISION: placeholder numbers (SPEC 20.4). Tune from real `llm_calls`/`budgets`
   * spend data before launch; also set a matching monthly cap in the provider's console.
   */
  budgets: {
    dailyAnonUsd: 5,
    dailyOverallUsd: 50,
  },
} as const;

export type Limits = typeof limits;
