// Rules-editor knobs (SPEC 8.11), in config and never inline in code (SPEC non-negotiable 8).
// Pure constants with no imports, so both the main thread and the worker read them.

export const editorConfig = {
  /** SPEC 8.11 "Live check": every change re-runs the engine on the example, debounced by about 150 ms. */
  debounceMs: 150,
  /** SPEC 8.11: the live check must stay under this for 5,000 rows... */
  liveBudgetMs: 300,
  /** ...and above that many example rows it runs on a subset live, and on all rows when the user presses Apply. */
  fullCheckAboveRows: 5_000,
  /** The subset's size (a deterministic prefix of the example's input rows). */
  subsetRows: 2_000,
  /** Undo/redo depth per stack. */
  historyCap: 100,
  /** Rows in the live-check preview table (mismatching rows first, then matching ones up to this many). */
  previewRows: 50,
  /** Cell-level mismatches returned (the counts are always exact; only the list is capped). */
  maxMismatches: 200,
  /** SPEC 8.11 "Calculate": up to 3 terms. */
  maxCalcTerms: 3,
} as const;
