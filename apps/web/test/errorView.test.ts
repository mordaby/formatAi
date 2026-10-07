import { API_ERROR_CODES, apiErrorMessages, limitMessages, LIMIT_CODES, preflightBlockMessages } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { blockView, errorView } from '../src/app/messages';
import type { FlowError } from '../src/flow/errors';
import { codeText, translate, type I18n, type Lang } from '../src/i18n';

function i18nFor(lang: Lang): I18n {
  return {
    lang,
    dir: lang === 'he' ? 'rtl' : 'ltr',
    setLang: () => {},
    toggle: () => {},
    t: (key, params) => translate(lang, key, params),
    code: (msg) => codeText(lang, msg),
  };
}

const api = (code: string, extra: Partial<Extract<FlowError, { kind: 'api' }>> = {}): FlowError => ({ kind: 'api', code: code as never, ...extra });

describe.each(['en', 'he'] as const)('error code -> message (%s)', (lang) => {
  const i18n = i18nFor(lang);

  it('shows the shared text of every API error code, never a raw code', () => {
    for (const code of API_ERROR_CODES) {
      if (code === 'limitHit') continue;
      const view = errorView(i18n, api(code));
      expect(view.text).toBe(apiErrorMessages[code][lang]);
      expect(view.text).not.toBe(code);
    }
  });

  it('limitHit shows the text of the specific limit', () => {
    for (const limit of LIMIT_CODES) {
      expect(errorView(i18n, api('limitHit', { limit })).text).toBe(limitMessages[limit][lang]);
    }
  });

  it('the anonymous limits nudge towards signing in; the budget and the anti-bot check do not', () => {
    expect(errorView(i18n, api('signInForAi'))).toMatchObject({ tone: 'info', action: 'signIn', text: apiErrorMessages.signInForAi[lang] });
    expect(errorView(i18n, api('limitHit', { limit: 'learnsPerDay' }))).toMatchObject({ tone: 'info', action: 'signIn' });
    expect(errorView(i18n, api('budgetExhausted'))).toMatchObject({ tone: 'block', action: 'none' });
    expect(errorView(i18n, api('turnstileFailed'))).toMatchObject({ tone: 'block', action: 'reload' });
  });

  it('the limits of one learn (the loop\'s rounds, the steps of AI code checks) are an amber block with Try again, never a sign-in nudge', () => {
    for (const limit of ['repairsPerLearn', 'stepsPerLearn'] as const) {
      expect(errorView(i18n, api('limitHit', { limit }))).toEqual({ tone: 'block', text: limitMessages[limit][lang], action: 'tryAgain' });
    }
  });

  it("API audit C1: the day's cap on requests to the AI is an amber block that says what keeps working - no sign-in, no retry", () => {
    expect(errorView(i18n, api('limitHit', { limit: 'aiRequestsPerDay' }))).toEqual({
      tone: 'block',
      text: limitMessages.aiRequestsPerDay[lang],
      todo: i18n.t('aiLimit.local'),
      action: 'none',
    });
  });

  it('rate limiting says when to try again, when the server said', () => {
    const plain = errorView(i18n, api('rateLimited'));
    expect(plain).toMatchObject({ tone: 'block', action: 'tryAgain', text: apiErrorMessages.rateLimited[lang] });
    expect(plain.todo).toBeUndefined();
    const timed = errorView(i18n, api('rateLimited', { retryAfterSec: 41.2 }));
    expect(timed.todo).toContain('42');
  });

  it('red is only for real failures: connection, server, crashes', () => {
    for (const error of [api('network'), api('server'), { kind: 'timeout' }, { kind: 'workerCrashed' }, { kind: 'unexpected', message: 'x' }] as FlowError[]) {
      expect(errorView(i18n, error).tone).toBe('error');
    }
    for (const error of [{ kind: 'fileTooLarge', fileName: 'a', bytes: 9e6, maxBytes: 5e6 }, { kind: 'unsupportedFileType' }, { kind: 'learnFailed', problems: [] }] as FlowError[]) {
      expect(errorView(i18n, error).tone).toBe('block');
    }
  });
});

describe('pre-flight blocks', () => {
  it('uses the shared reason text, plus what to do where there is something to do', () => {
    for (const lang of ['en', 'he'] as const) {
      const i18n = i18nFor(lang);
      for (const code of ['rowExpansionUnsupported', 'pivotDetected', 'noColumnTraced', 'identicalFiles'] as const) {
        const view = blockView(i18n, { code, severity: 'block' });
        expect(view.text).toBe(preflightBlockMessages[code][lang]);
        expect(view.todo).toBeTruthy();
      }
    }
  });

  it('names the table problem and the file it is in, in both languages', () => {
    const issue = { code: 'tableRejected', severity: 'block', params: { side: 'output', tableIssueCode: 'mergedHeader', row: 2, fromCol: 'A', toCol: 'C' } } as const;
    expect(blockView(i18nFor('en'), issue).text).toBe('In the example output, row 2 has cells merged across columns A–C. Unmerge them and upload the file again.');
    expect(blockView(i18nFor('he'), issue).text).toBe('בקובץ הפלט לדוגמה בשורה 2 יש תאים ממוזגים בעמודות A–C. בטלו את המיזוג והעלו את הקובץ שוב.');
  });

  it('falls back to the generic table message for an issue it has no words for', () => {
    const issue = { code: 'tableRejected', severity: 'block', params: { side: 'input', tableIssueCode: 'somethingNew' } } as const;
    expect(blockView(i18nFor('en'), issue).text).toBe(preflightBlockMessages.tableRejected.en);
  });

  it('knows the free-plan limits and offers to sign in', () => {
    const rows = blockView(i18nFor('en'), { code: 'overTierLimits', severity: 'block', params: { dimension: 'rows', value: 412, limit: 300 } });
    expect(rows.text).toContain('412 rows');
    expect(rows.offerSignIn).toBe(true);
    const cols = blockView(i18nFor('he'), { code: 'overTierLimits', severity: 'block', params: { dimension: 'columns', value: 31, limit: 20 } });
    expect(cols.text).toContain('31 עמודות');
  });
});
