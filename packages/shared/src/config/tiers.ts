// SPEC 11 (v3 rewrite, SPEC 21 "v3 changes" #3): free / registered / paid tiers.
// All numbers here are starting placeholders (SPEC 20.4), to be tuned from
// `limit_hit` event data. B2B is the business (SPEC 1); the public app's free and
// registered tiers are a demand funnel, and batch conversion is a paid-only feature
// (SPEC 21: "batch is paid only").

export type Tier = 'anonymous' | 'registered' | 'paid';

export type LearnPeriod = 'day' | 'month';

export interface TierLimits {
  maxRowsPerFile: number;
  maxColumns: number;
  /** SPEC 11 "Files per run": 1 for free/registered; paid can batch up to this many. */
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
  /** "Learns that reach the LLM" (SPEC 11). Fast-path/cache learns don't count (SPEC 6.5). */
  learnsToLlm: { count: number; period: LearnPeriod };
  fastPathLearns: 'unlimited';
  editRules: boolean;
}

export const tiers: Record<Tier, TierLimits> = {
  anonymous: {
    maxRowsPerFile: 300,
    maxColumns: 20,
    filesPerRun: 1,
    previewRows: 20,
    fullDownload: false,
    savedFormats: 0,
    sourcesPerFormat: 0,
    rulesPerFormat: 30,
    learnsToLlm: { count: 2, period: 'day' },
    fastPathLearns: 'unlimited',
    editRules: false,
  },
  registered: {
    maxRowsPerFile: 5_000,
    maxColumns: 50,
    filesPerRun: 1,
    previewRows: null,
    fullDownload: true,
    savedFormats: 3,
    sourcesPerFormat: 3,
    rulesPerFormat: 30,
    learnsToLlm: { count: 10, period: 'month' },
    fastPathLearns: 'unlimited',
    editRules: true,
  },
  paid: {
    maxRowsPerFile: 100_000,
    maxColumns: 150,
    // SPEC 11 "Files per run": "batch, up to 50".
    filesPerRun: 50,
    previewRows: null,
    fullDownload: true,
    savedFormats: 'unlimited',
    newSavedFormatsPerMonth: 50,
    sourcesPerFormat: 'unlimited',
    rulesPerFormat: 300,
    learnsToLlm: { count: 150, period: 'month' },
    fastPathLearns: 'unlimited',
    editRules: true,
  },
};
