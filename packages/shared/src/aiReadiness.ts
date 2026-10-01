// SPEC 21 v5 items 1 and 4: the codes and he/en texts behind the AI readiness gate and the
// local partial result (packages/engine `aiReadiness`, `partialRules`). Kept in one module
// of its own so the vocabulary of "why the AI step didn't run" lives in one place; the
// engine returns codes with params, and this dictionary is the only source of the words
// (SPEC 16.2: the UI text is never written by code or by the LLM). Placeholders such as
// `{column}` are filled from the issue's `params`, like `flagMessages`.
import type { Localized } from './i18n/messages';

// ---------- SPEC 21 v5 item 4: why the AI step isn't attempted ----------
// The gate is deliberately minimal: it stops only what is CERTAIN to fail even with the AI, and
// lets every ambiguous case (few rows, some unmatched rows, a messy column, a column no detector
// explained) go to the LLM. "Code found no relation" is not certainty, so there is no code for
// "only external columns are left": the AI step tries them. None of these consume a learn. Each
// message says what to fix.
export const AI_READINESS_ISSUE_CODES = [
  // Blocks: no output data row could be matched to an input row, so there are no example pairs
  // to learn from (the two files don't seem to come from the same data).
  'noRowsMatched',
  // Block: the payload is still over its caps after trimming - one code per part that is too large.
  'inputColumnsTooMany',
  'outputColumnsTooMany',
  'payloadTooLarge',
] as const;
export type AiReadinessIssueCode = (typeof AI_READINESS_ISSUE_CODES)[number];

/**
 * Params per code (numbers and strings only, never cell values):
 *  - noRowsMatched: { }
 *  - inputColumnsTooMany / outputColumnsTooMany: { count, limit }
 *  - payloadTooLarge: { kb, limitKb } (the size of what would be sent, after trimming)
 */
export const aiReadinessMessages: Record<AiReadinessIssueCode, Localized> = {
  noRowsMatched: {
    en: "None of the rows in your example output match a row of your input file, so the two files don't seem to come from the same data. Check that the example output was made from this input file and try again.",
    he: 'אף אחת מהשורות בפלט לדוגמה לא תואמת שורה בקובץ הקלט, ולכן נראה ששני הקבצים לא מאותם נתונים. ודאו שהפלט לדוגמה נוצר מקובץ הקלט הזה ונסו שוב.',
  },
  inputColumnsTooMany: {
    en: "Your input file has {count} columns, and the AI step can take at most {limit}. Remove the columns you don't need from the input file and try again.",
    he: 'בקובץ הקלט יש {count} עמודות, ושלב ה־AI מקבל לכל היותר {limit}. הסירו מקובץ הקלט את העמודות שלא צריך ונסו שוב.',
  },
  outputColumnsTooMany: {
    en: "Your example output has {count} columns, and the AI step can take at most {limit}. Remove the columns you don't need from the example output and try again.",
    he: 'בפלט לדוגמה יש {count} עמודות, ושלב ה־AI מקבל לכל היותר {limit}. הסירו מהפלט לדוגמה את העמודות שלא צריך ונסו שוב.',
  },
  payloadTooLarge: {
    en: "Even after trimming, the data we would send to the AI step is too large ({kb} KB; the limit is {limitKb} KB). Remove long text columns or columns you don't need from both files and try again.",
    he: 'גם אחרי הקטנה, הנתונים שהיינו שולחים לשלב ה־AI גדולים מדי ({kb} KB; המגבלה היא {limitKb} KB). הסירו משני הקבצים עמודות טקסט ארוכות או עמודות שלא צריך ונסו שוב.',
  },
};

// ---------- SPEC 21 v5 item 1: what the local result could not build ----------
// The parts of a rules file (besides columns, which are listed by header) that still need the
// AI step after the local partial result.
export const AI_STEP_PART_CODES = ['rows', 'droppedRows', 'sort', 'group', 'summaryRows', 'dateTitle', 'blankRows'] as const;
export type AiStepPartCode = (typeof AI_STEP_PART_CODES)[number];

export const aiStepPartMessages: Record<AiStepPartCode, Localized> = {
  rows: {
    en: 'How the rows change shape (one row into several, or grouped into a summary).',
    he: 'איך השורות משנות צורה (שורה אחת לכמה שורות, או קיבוץ לסיכום).',
  },
  droppedRows: {
    en: 'Which rows are left out.',
    he: 'אילו שורות מושמטות.',
  },
  sort: {
    en: 'How the rows are sorted.',
    he: 'איך השורות ממוינות.',
  },
  group: {
    en: 'How the rows are grouped.',
    he: 'איך השורות מקובצות.',
  },
  summaryRows: {
    en: 'The summary or total rows.',
    he: 'שורות הסיכום או הסכום.',
  },
  dateTitle: {
    en: 'A title that contains a date taken from the data.',
    he: 'כותרת שכוללת תאריך מתוך הנתונים.',
  },
  blankRows: {
    en: 'The blank rows between groups.',
    he: 'השורות הריקות בין הקבוצות.',
  },
};
