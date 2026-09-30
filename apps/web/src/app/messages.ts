// What the pre-flight and error screens say: the exact reason, and what to do about it
// (SPEC 6.3, 6.4, 16.3). The reasons themselves come from the shared he/en dictionary
// (`useI18n().code`); this file only picks the more specific wording where one exists and adds
// the "what to do" line. Nothing here is typed by the LLM.
import { limits, type PreflightBlockReason } from '@formatai/shared';
import type { PreflightIssue } from '@formatai/engine';
import type { FlowError } from '../flow/errors';
import { flowErrorText } from '../flow/errors';
import type { I18n, MessageKey } from '../i18n';
import type { InlineMessageTone } from '../ui';

const TABLE_ISSUES: ReadonlySet<string> = new Set(['noHeaderRow', 'multipleTables', 'mergedHeader', 'splitHeader', 'tooFewDataRows', 'onlyDrawings', 'emptySheet']);

const TODO: Partial<Record<PreflightBlockReason, MessageKey>> = {
  rowExpansionUnsupported: 'preflight.todo.rowExpansionUnsupported',
  pivotDetected: 'preflight.todo.pivotDetected',
  noColumnTraced: 'preflight.todo.noColumnTraced',
  identicalFiles: 'preflight.todo.identicalFiles',
};

export interface BlockView {
  /** Why these files can't be learned from. */
  text: string;
  /** What to do next (when the reason itself doesn't already say). */
  todo?: string;
  /** Signing in would lift this limit. */
  offerSignIn?: boolean;
}

/** One pre-flight block, in words: specific when we know which table problem or limit it was. */
export function blockView(i18n: I18n, issue: PreflightIssue): BlockView {
  const { t, code } = i18n;
  const p = issue.params ?? {};

  if (issue.code === 'tableRejected' && typeof p.tableIssueCode === 'string' && TABLE_ISSUES.has(p.tableIssueCode)) {
    const { side, tableIssueCode, ...rest } = p;
    return {
      text: t(`preflight.table.${tableIssueCode}` as MessageKey, {
        ...rest,
        side: t(side === 'output' ? 'preflight.side.output' : 'preflight.side.input'),
      }),
    };
  }

  if (issue.code === 'overTierLimits' && (p.dimension === 'rows' || p.dimension === 'columns')) {
    return {
      text: t(p.dimension === 'rows' ? 'preflight.overTier.rows' : 'preflight.overTier.columns', { value: Number(p.value), limit: Number(p.limit) }),
      offerSignIn: true,
    };
  }

  const todoKey = TODO[issue.code as PreflightBlockReason];
  return { text: code({ kind: 'preflight', code: issue.code, ...(issue.params ? { params: issue.params } : {}) }), ...(todoKey ? { todo: t(todoKey) } : {}) };
}

export type ErrorAction = 'tryAgain' | 'signIn' | 'reload' | 'upgrade' | 'none';

export interface ErrorView {
  tone: InlineMessageTone;
  title?: string;
  text: string;
  todo?: string;
  /** The one main thing to offer next. */
  action: ErrorAction;
}

/**
 * How a failed learn is shown. Red is for real failures (the server, a crash); a file the tool
 * can't use, or a limit reached, is an amber block or a teal nudge to sign in.
 */
export function errorView(i18n: I18n, error: FlowError): ErrorView {
  const text = flowErrorText(i18n, error);
  switch (error.kind) {
    case 'fileTooLarge':
    case 'unsupportedFileType':
    case 'learnFailed':
      return { tone: 'block', text, action: 'none' };
    case 'timeout':
    case 'workerCrashed':
    case 'unexpected':
      return { tone: 'error', text, action: 'tryAgain' };
    case 'api':
      switch (error.code) {
        // SPEC 11, 21 v5 item 2: the AI quota is used up - say for how long, and offer the upgrade (paid plans are set up by the team).
        case 'limitHit':
          if (error.limit === 'aiLearns') return { tone: 'block', text, todo: i18n.t('aiLimit.local'), action: 'upgrade' };
          return { tone: 'info', text, action: 'signIn' };
        case 'anonBudgetExhausted':
        // The session ended (or the AI step was called signed out): the local result stays, sign in to finish.
        case 'signInForAi':
          return { tone: 'info', text, action: 'signIn' };
        // SPEC 21 v5 item 3: the failed-attempt stop - what was tried, whether it counted, and what to change.
        case 'aiAttemptsExhausted':
          return { tone: 'block', title: i18n.t('aiExhausted.title', { n: limits.learn.maxFailedAiAttempts }), text, todo: i18n.t('aiExhausted.todo'), action: 'none' };
        case 'budgetExhausted':
          return { tone: 'block', text, action: 'none' };
        case 'rateLimited':
          return {
            tone: 'block',
            text,
            ...(error.retryAfterSec ? { todo: i18n.t('error.retryAfter', { seconds: Math.ceil(error.retryAfterSec) }) } : {}),
            action: 'tryAgain',
          };
        case 'turnstileFailed':
          return { tone: 'block', text, action: 'reload' };
        case 'payloadTooLarge':
          return { tone: 'error', text, action: 'none' };
        default:
          return { tone: 'error', text, action: 'tryAgain' };
      }
  }
}
