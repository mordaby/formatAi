// SPEC 11: tier limits. All numbers here are starting placeholders (SPEC 20.4),
// to be tuned from `limit_hit` event data.

export type Tier = 'anonymous' | 'registered' | 'paid';

export type LearnPeriod = 'day' | 'month';

export interface TierLimits {
  maxRowsPerFile: number;
  maxColumns: number;
  /** Rows shown on screen; `null` means the full result can be downloaded. */
  previewRows: number | null;
  fullDownload: boolean;
  /** "Learns that reach the LLM" (SPEC 11). Fast-path/cache learns don't count (SPEC 6.5). */
  learnsToLlm: { count: number; period: LearnPeriod };
  fastPathLearns: 'unlimited';
  savedFormats: number | 'unlimited';
  /** Only set when savedFormats is 'unlimited' (SPEC 11: paid has a soft cap of 100). */
  savedFormatsSoftCap?: number;
  /** Max files per batch run. 0 means batch isn't available on this tier. */
  batchFiles: number;
  editRules: boolean;
}

export const tiers: Record<Tier, TierLimits> = {
  anonymous: {
    maxRowsPerFile: 300,
    maxColumns: 20,
    previewRows: 20,
    fullDownload: false,
    learnsToLlm: { count: 2, period: 'day' },
    fastPathLearns: 'unlimited',
    savedFormats: 0,
    batchFiles: 0,
    editRules: false,
  },
  registered: {
    maxRowsPerFile: 5_000,
    maxColumns: 50,
    previewRows: null,
    fullDownload: true,
    learnsToLlm: { count: 10, period: 'month' },
    fastPathLearns: 'unlimited',
    savedFormats: 3,
    // DECISION (SPEC 20.3): batch for registered users defaults to up to 3 files,
    // "as a taste"; the alternative considered was no batch at all for this tier.
    batchFiles: 3,
    editRules: true,
  },
  paid: {
    maxRowsPerFile: 100_000,
    maxColumns: 150,
    previewRows: null,
    fullDownload: true,
    learnsToLlm: { count: 100, period: 'month' },
    fastPathLearns: 'unlimited',
    savedFormats: 'unlimited',
    savedFormatsSoftCap: 100,
    batchFiles: 50,
    editRules: true,
  },
};
