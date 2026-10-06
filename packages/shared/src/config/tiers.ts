// SPEC 11 (v3 rewrite, SPEC 21 "v3 changes" #3): free / registered / paid tiers.
// All numbers here are starting placeholders (SPEC 20.4), to be tuned from
// `limit_hit` event data. B2B is the business (SPEC 1); the public app's free and
// registered tiers are a demand funnel. One Run screen serves every tier that has saved formats
// (SPEC 5 C/D, 21 v11): one file or several, and `filesPerRun` is how many it takes at once.

export type Tier = 'anonymous' | 'registered' | 'paid';

/**
 * SPEC 11 / 21 v5: the period an AI-learn quota is counted over. `lifetime` never resets (a one-time allowance),
 * `month` and `day` reset with the UTC month / UTC day, `unlimited` has no cap.
 */
export type AiLearnPeriod = 'lifetime' | 'month' | 'day' | 'unlimited';

export interface AiLearnQuota {
  /** How many AI learns fit in one `period` (ignored for `unlimited`). */
  count: number;
  period: AiLearnPeriod;
}

export interface TierLimits {
  /** SPEC 6.1/15: maximum upload size in bytes (placeholder, tune from limit_hit data). */
  maxFileBytes: number;
  maxRowsPerFile: number;
  maxColumns: number;
  /**
   * SPEC 11 "Files per run": how many files the Run screen takes at once (1 = a single file; more = a batch). Free has no saved
   * formats, so its one file is the rules it just learned, tried from the Result screen (nothing saved).
   */
  filesPerRun: number;
  /** Rows shown on screen; `null` means the full result can be downloaded. */
  previewRows: number | null;
  fullDownload: boolean;
  /** SPEC 11 "Saved formats": a lifetime total for free/registered (0 = none saved).
   * Paid has no lifetime cap ('unlimited') but a monthly creation cap instead - see
   * `newSavedFormatsPerMonth` (DECISION 9: "50 new formats per calendar month"). */
  savedFormats: number | 'unlimited';
  /** Only set when savedFormats is 'unlimited' (paid: 50 new formats per calendar
   * month, DECISION 9 - a monthly rate, not a lifetime total). */
  newSavedFormatsPerMonth?: number;
  /** SPEC 11 "Sources per format". 0 means a format/source can't be created at all
   * on this tier (free has no saved formats to add sources to). */
  sourcesPerFormat: number | 'unlimited';
  /** SPEC 8.14/11 "Rules per format": functions, tables, output columns, filters,
   * dedupe, expand, sort, group and validations each count as one rule. */
  rulesPerFormat: number;
  /**
   * SPEC 11 / 21 v5: "AI learns" - learns that reach the LLM. Only signed-in users have any (anonymous: 0);
   * a learn counts once, when it succeeds (never for a failed attempt, except the one that ends
   * `limits.learn.maxFailedAiAttempts` failed attempts on the same example pair). Fast-path and cache
   * learns never count (SPEC 6.5). Changing the numbers or the period is config only.
   */
  aiLearns: AiLearnQuota;
  fastPathLearns: 'unlimited';
  editRules: boolean;
}

export const tiers: Record<Tier, TierLimits> = {
  anonymous: {
    maxFileBytes: 5 * 1024 * 1024,
    maxRowsPerFile: 300,
    maxColumns: 20,
    filesPerRun: 1,
    previewRows: 20,
    fullDownload: false,
    savedFormats: 0,
    sourcesPerFormat: 0,
    rulesPerFormat: 30,
    aiLearns: { count: 0, period: 'lifetime' },
    fastPathLearns: 'unlimited',
    editRules: false,
  },
  registered: {
    maxFileBytes: 25 * 1024 * 1024,
    maxRowsPerFile: 5_000,
    maxColumns: 50,
    filesPerRun: 5,
    previewRows: null,
    fullDownload: true,
    savedFormats: 3,
    sourcesPerFormat: 3,
    rulesPerFormat: 30,
    // Owner decision (2026-10-06): 500 a month for the beta (3-4 testers before marketing). The daily overall budget
    // (`limits.budgets.dailyOverallUsd`) still caps the spend; lower it again (or use the admin's per-user `limitOverrides.aiLearns`)
    // before the public launch.
    aiLearns: { count: 500, period: 'month' },
    fastPathLearns: 'unlimited',
    editRules: true,
  },
  paid: {
    maxFileBytes: 100 * 1024 * 1024,
    maxRowsPerFile: 100_000,
    maxColumns: 150,
    // DECISION: 50 stays the paid maximum. Every converted file is held in memory until the zip is made, so the limit follows
    // what a browser tab can hold (100,000 rows per file is the worst case), not what the engine could process.
    filesPerRun: 50,
    previewRows: null,
    fullDownload: true,
    savedFormats: 'unlimited',
    newSavedFormatsPerMonth: 50,
    sourcesPerFormat: 'unlimited',
    rulesPerFormat: 300,
    // Owner decision (2026-10-06): never below the registered tier (see there).
    aiLearns: { count: 500, period: 'month' },
    fastPathLearns: 'unlimited',
    editRules: true,
  },
};
