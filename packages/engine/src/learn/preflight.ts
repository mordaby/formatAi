// Pre-flight (SPEC 6.3 block, 6.4 warn): runs in the browser, on the real
// pair-analysis result, before any LLM call. A block costs nothing (SPEC 5 A
// step 2); a warn lets the user continue ("try anyway"), which still counts as a
// learn. An 'info' issue (columns no detector explained) never stops anything.
//
// This module only classifies what `analyzePair` already found; it never
// re-reads the files or re-tests relations.

import type { PreflightBlockReason, PreflightWarnReason, Tier } from '@formatai/shared';
import { tiers } from '@formatai/shared';
import { isExternalColumn, type PairAnalysis, type PairAnalysisResult } from './analyze';

export interface PreflightIssue {
  code: PreflightBlockReason | PreflightWarnReason;
  /** 'info' is a note only (SPEC 6.4 `unknownOutputColumns`): no gate, no status change - the AI step tries those columns. */
  severity: 'block' | 'warn' | 'info';
  /** Structured details for the i18n message (e.g. which table issue, or the
   * measured value vs. the tier's limit). Never cell values. */
  params?: Record<string, string | number>;
}

export interface PreflightResult {
  status: 'ok' | 'warn' | 'block';
  issues: PreflightIssue[];
  /**
   * Output column positions the LLM is told to skip (`"from": null`, sent as `payload.skipColumns`): ONLY columns the user explicitly
   * marked to skip. Nothing sets it today, so it is empty. A column code could not explain (external or derived, whatever the internal
   * classification) is NEVER here: "code found no relation" is not certainty, so the AI step gets it like any other output column and
   * may answer `unsupported` with `externalData` (SPEC 6.4, 21 v7 note).
   */
  skipColumns: number[];
}

function block(code: PreflightBlockReason, params?: Record<string, string | number>): PreflightIssue {
  return params ? { code, severity: 'block', params } : { code, severity: 'block' };
}

function warn(code: PreflightWarnReason, params?: Record<string, string | number>): PreflightIssue {
  return params ? { code, severity: 'warn', params } : { code, severity: 'warn' };
}

function info(code: PreflightWarnReason, params?: Record<string, string | number>): PreflightIssue {
  return params ? { code, severity: 'info', params } : { code, severity: 'info' };
}

/** SPEC 6.3 "the files are over the tier's limits": measured against the larger
 * of the two sides, since either the input or the (hand-made) example output
 * could be the one that is oversized. */
function overTierLimitsIssue(a: PairAnalysis, tier: Tier): PreflightIssue | null {
  const t = tiers[tier];
  const rows = Math.max(a.input.rows.length, a.output.dataRows.length);
  if (rows > t.maxRowsPerFile) return block('overTierLimits', { dimension: 'rows', value: rows, limit: t.maxRowsPerFile });
  const columns = Math.max(a.input.columnCount, a.output.columnCount);
  if (columns > t.maxColumns) return block('overTierLimits', { dimension: 'columns', value: columns, limit: t.maxColumns });
  return null;
}

/**
 * Classifies a pair analysis (or its 6.1 table-check failure) into pre-flight
 * issues, a status, and the output columns to skip.
 */
export function preflight(analysis: PairAnalysisResult, tier: Tier): PreflightResult {
  if (!analysis.ok) {
    // SPEC 6.3: "a 6.1 rejection". Every 'reject' issue from either file becomes
    // its own block issue; the specific TableIssueCode/side is kept in params
    // for a more precise UI message than the generic one.
    const issues: PreflightIssue[] = analysis.issues
      .filter((i) => i.severity === 'reject')
      .map((i) =>
        block('tableRejected', {
          side: i.side,
          tableIssueCode: i.code,
          ...(i.params ?? {}),
        }),
      );
    return { status: 'block', issues, skipColumns: [] };
  }

  const issues: PreflightIssue[] = [];

  // ---- SPEC 6.3 blocks ----
  if (analysis.shape.kind === 'rowExpansion') issues.push(block('rowExpansionUnsupported'));
  if (analysis.shape.kind === 'pivot' || analysis.pivot !== null) issues.push(block('pivotDetected'));
  // A derived column is traced to the input (it is a function of it); only external columns aren't.
  const noColumnTraced = analysis.columns.length === 0 || analysis.columns.every(isExternalColumn);
  if (noColumnTraced) issues.push(block('noColumnTraced'));
  if (analysis.identical) issues.push(block('identicalFiles'));
  const overLimits = overTierLimitsIssue(analysis, tier);
  if (overLimits) issues.push(overLimits);

  // ---- SPEC 6.4 ----
  // Columns no relation and no dependency explains (the internal "external" class). Informational only: they are NOT skipped, the AI
  // step tries them (and what it can't produce stays empty). Every column external is already the (stronger) noColumnTraced block above;
  // the note is for "some, but not all" columns.
  const external = analysis.columns.filter(isExternalColumn);
  if (external.length > 0 && !noColumnTraced) {
    issues.push(info('unknownOutputColumns', { count: external.length }));
  }
  if (analysis.alignment.unalignedOut.length > 0) {
    issues.push(warn('rowsNotAligned', { count: analysis.alignment.unalignedOut.length }));
  }

  const status: PreflightResult['status'] = issues.some((i) => i.severity === 'block')
    ? 'block'
    : issues.some((i) => i.severity === 'warn')
      ? 'warn'
      : 'ok';

  return { status, issues, skipColumns: [] };
}
