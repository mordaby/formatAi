// Plain-language he/en text for every unsupported and assumption code (SPEC 8.10,
// tone per SPEC 16.3: no jargon, say exactly what's true and what the user can do).
// The LLM never writes UI text (SPEC 16.2); this dictionary is the only source of it.
import type { AiLearnPeriod } from '../config/tiers';
import type {
  ApiErrorCode,
  AssumptionReasonCode,
  FlagMessageKey,
  LimitCode,
  PreflightBlockReason,
  PreflightWarnReason,
  UnsupportedReasonCode,
} from '../codes';

export interface Localized {
  en: string;
  he: string;
}

export const unsupportedMessages: Record<UnsupportedReasonCode, Localized> = {
  externalData: {
    en: "This column's values don't come from your input file, so we can't fill it in.",
    he: 'הערכים בעמודה הזו לא מגיעים מקובץ הקלט שלך, ולכן לא נוכל למלא אותה.',
  },
  pivot: {
    en: "This report turns values into column headers, which isn't supported yet.",
    he: 'הדוח הזה הופך ערכים לכותרות עמודות, ואפשרות זו עדיין לא נתמכת.',
  },
  rowExpansion: {
    en: 'One input row needs to become several output rows in a way we don’t recognize yet.',
    he: 'שורת קלט אחת צריכה להפוך למספר שורות פלט, בדרך שאנחנו לא מזהים עדיין.',
  },
  crossRowCalculation: {
    en: 'This column needs information from other rows, like a running total or the previous row, which isn’t supported yet.',
    he: 'העמודה הזו דורשת מידע משורות אחרות, כמו סכום מצטבר או השורה הקודמת, ואפשרות זו עדיין לא נתמכת.',
  },
  hiddenByMasking: {
    en: 'With masking on, we can’t see what’s inside this column’s text. Turn masking off or fill in this column yourself.',
    he: 'כשהסתרת הנתונים פעילה, אי אפשר לראות מה יש בתוך הטקסט בעמודה הזו. כבו את ההסתרה או מלאו את העמודה בעצמכם.',
  },
  ambiguous: {
    en: 'There’s more than one way to read this column, and picking wrong could cause errors, so we left it for you to set.',
    he: 'יש יותר מדרך אחת להבין את העמודה הזו, וטעות בבחירה עלולה לגרום לשגיאות, אז השארנו לכם להגדיר אותה.',
  },
  other: {
    en: "We couldn't figure out how to build this column.",
    he: 'לא הצלחנו להבין איך לבנות את העמודה הזו.',
  },
  overfit: {
    en: 'The only rule we found for this column copies particular rows of your example, so it would be wrong on your next file. Please set this column yourself.',
    he: 'הכלל היחיד שמצאנו לעמודה הזו מעתיק שורות מסוימות מהדוגמה שלך, ולכן הוא יטעה בקובץ הבא. אנא הגדירו את העמודה הזו בעצמכם.',
  },
  savedWithout: {
    en: "You saved this format without this column's rule, because it kept an ID number or similar details. Please set this column yourself.",
    he: 'שמרתם את הפורמט בלי הכלל של העמודה הזו, כי הוא שמר מספר זהות או פרטים דומים. אנא הגדירו את העמודה הזו בעצמכם.',
  },
};

export const assumptionMessages: Record<AssumptionReasonCode, Localized> = {
  rateGuessed: {
    en: 'We guessed a fixed rate for this column. Please check it.',
    he: 'ניחשנו שיעור קבוע עבור העמודה הזו. אנא בדקו אותו.',
  },
  roundingGuessed: {
    en: 'We guessed how this number should be rounded. Please check it.',
    he: 'ניחשנו איך לעגל את המספר הזה. אנא בדקו.',
  },
  filterGuessed: {
    en: 'We guessed which rows to keep and which to drop. Please check this.',
    he: 'ניחשנו אילו שורות לשמור ואילו להשמיט. אנא בדקו זאת.',
  },
  sortGuessed: {
    en: 'We guessed how the rows should be sorted. Please check this.',
    he: 'ניחשנו איך למיין את השורות. אנא בדקו זאת.',
  },
  formatGuessed: {
    en: 'We guessed the number or date format for this column. Please check it.',
    he: 'ניחשנו את פורמט המספר או התאריך בעמודה הזו. אנא בדקו.',
  },
  titleGuessed: {
    en: 'We guessed how the title should be built. Please check it.',
    he: 'ניחשנו איך לבנות את הכותרת. אנא בדקו.',
  },
  overfitSuspected: {
    en: 'This rule looks tailored to the example rows rather than the general case. Please check it.',
    he: 'הכלל הזה נראה מותאם לשורות הדוגמה ולא למקרה הכללי. אנא בדקו אותו.',
  },
  other: {
    en: 'We made a guess here. Please check it.',
    he: 'ניחשנו כאן משהו. אנא בדקו.',
  },
};

// Pre-flight messages (SPEC 6.3 block, 6.4 warn). A `tableRejected` block also
// carries the underlying `tableIssueCode`/`side` in its params, for a UI that
// wants a more specific message than this generic one.
export const preflightBlockMessages: Record<PreflightBlockReason, Localized> = {
  tableRejected: {
    en: "We couldn't read this file as a table. Check the sheet and try again.",
    he: 'לא הצלחנו לקרוא את הקובץ הזה כטבלה. בדקו את הגיליון ונסו שוב.',
  },
  rowExpansionUnsupported: {
    en: 'One input row needs to become several output rows in a way we don’t recognize yet.',
    he: 'שורת קלט אחת צריכה להפוך למספר שורות פלט, בדרך שאנחנו לא מזהים עדיין.',
  },
  pivotDetected: {
    en: "This report turns values into column headers, which isn't supported yet.",
    he: 'הדוח הזה הופך ערכים לכותרות עמודות, ואפשרות זו עדיין לא נתמכת.',
  },
  noColumnTraced: {
    en: "None of the output columns could be traced back to your input file. Are these the right two files?",
    he: 'אף אחת מעמודות הפלט לא נמצאה מתאימה לקובץ הקלט. אלה שני הקבצים הנכונים?',
  },
  identicalFiles: {
    en: 'These two files are identical, so there is nothing to learn.',
    he: 'שני הקבצים זהים, אז אין מה ללמוד.',
  },
  overTierLimits: {
    en: 'This file is larger than your plan allows.',
    he: 'הקובץ הזה גדול יותר ממה שהתוכנית שלכם מאפשרת.',
  },
};

export const preflightWarnMessages: Record<PreflightWarnReason, Localized> = {
  unknownOutputColumns: {
    en: "We couldn't find these columns' values in your input file. The AI step will try them; if they come from another source they'll stay empty.",
    he: 'לא מצאנו את הערכים של העמודות האלה בקובץ הקלט שלכם. שלב ה-AI ינסה אותן; אם הן מגיעות ממקור אחר, הן יישארו ריקות.',
  },
  rowsNotAligned: {
    en: 'We couldn’t match rows between the two files. Are they from the same data?',
    he: 'לא הצלחנו להתאים שורות בין שני הקבצים. הם מאותם נתונים?',
  },
};

// Flag messages (SPEC 8.9). `{name}` placeholders are filled from Flag.params.
export const flagMessages: Record<FlagMessageKey, Localized> = {
  'flag.parseFailed.number': {
    en: "This isn't a number. We kept it as it is.",
    he: 'זה לא מספר. השארנו אותו כפי שהוא.',
  },
  'flag.parseFailed.integer': {
    en: "This isn't a whole number. We kept it as it is.",
    he: 'זה לא מספר שלם. השארנו אותו כפי שהוא.',
  },
  'flag.parseFailed.date': {
    en: "This isn't a date we can read. We kept it as it is.",
    he: 'זה לא תאריך שאנחנו יכולים לקרוא. השארנו אותו כפי שהוא.',
  },
  'flag.parseFailed.idLike': {
    en: "This doesn't look like an ID number. We kept it as it is.",
    he: 'זה לא נראה כמו מספר מזהה. השארנו אותו כפי שהוא.',
  },
  'flag.parseFailed.boolean': {
    en: 'Expected yes/no (TRUE/FALSE or 1/0). We kept it as it is.',
    he: 'ציפינו לכן/לא (TRUE/FALSE או 1/0). השארנו את הערך כפי שהוא.',
  },
  'flag.duplicateOf': {
    en: 'Duplicate of row {duplicateOf}.',
    he: 'כפילות של שורה {duplicateOf}.',
  },
  'flag.expr.divByZero': {
    en: 'Division by zero or by an empty cell. The result was left empty.',
    he: 'חלוקה באפס או בתא ריק. התוצאה נשארה ריקה.',
  },
  'flag.expr.notNumber': {
    en: 'The calculation needs a number here, but found text.',
    he: 'החישוב צריך כאן מספר, אבל נמצא טקסט.',
  },
  'flag.expr.notDate': {
    en: 'The calculation needs a date here, but found something else.',
    he: 'החישוב צריך כאן תאריך, אבל נמצא ערך אחר.',
  },
  'flag.valueMapMissing': {
    en: "This value isn't in the translation list. We kept it as it is.",
    he: 'הערך הזה לא מופיע ברשימת התרגום. השארנו אותו כפי שהוא.',
  },
  'flag.lookupMissing': {
    en: "This value isn't in the lookup table. We left the result empty.",
    he: 'הערך הזה לא נמצא בטבלת החיפוש. השארנו את התוצאה ריקה.',
  },
  'flag.validation.required': {
    en: 'This cell is empty, but it should always have a value.',
    he: 'התא ריק, אבל תמיד אמור להיות בו ערך.',
  },
  'flag.validation.israeliIdChecksum': {
    en: "This isn't a valid Israeli ID number (the check digit doesn't match).",
    he: 'זה לא מספר זהות תקין (ספרת הביקורת לא מתאימה).',
  },
  'flag.validation.range': {
    en: 'This value is outside the expected range.',
    he: 'הערך מחוץ לטווח הצפוי.',
  },
  'flag.validation.lengthEquals': {
    en: 'This value should be {length} characters long.',
    he: 'הערך צריך להיות באורך {length} תווים.',
  },
  'flag.validation.oneOf': {
    en: "This value isn't one of the allowed values.",
    he: 'הערך הזה אינו אחד מהערכים המותרים.',
  },
  'flag.validation.unique': {
    en: 'This value already appears in row {firstRow}.',
    he: 'הערך הזה כבר מופיע בשורה {firstRow}.',
  },
  'flag.validation.dateRange': {
    en: 'This date is outside {from} – {to}.',
    he: 'התאריך מחוץ לטווח {from} – {to}.',
  },
  'flag.validation.cutoffRange': {
    en: 'Your example did not settle which side of the cut-off this value is on (between {low} and {high}; we used {value}). Please check it.',
    he: 'הדוגמה שלך לא קבעה באיזה צד של הסף נמצא הערך הזה (בין {low} לבין {high}; השתמשנו ב-{value}). כדאי לבדוק.',
  },
  'flag.validation.sameAs': {
    en: 'Your example fits two rules for this column, and here they differ: the other rule gives {other}. Please check it.',
    he: 'הדוגמה שלך מתאימה לשני כללים בעמודה הזו, וכאן הם שונים: הכלל השני נותן {other}. כדאי לבדוק.',
  },
  'flag.validation.sameAs.oneTime': {
    en: 'This row gets a part of the rule that your example had on one row only; without it the rule gives {other}. Please check it.',
    he: 'השורה הזו מקבלת חלק מהכלל שהיה בדוגמה שלך בשורה אחת בלבד; בלעדיו הכלל נותן {other}. כדאי לבדוק.',
  },
};

// API error messages (SPEC 9.5, 11). The API returns only codes; the web shows this text.
// `limitHit` is generic - show the matching `limitMessages` entry for its `limit` instead.
export const apiErrorMessages: Record<ApiErrorCode, Localized> = {
  invalidPayload: {
    en: 'Something went wrong with this request. Please try again.',
    he: 'משהו השתבש בבקשה הזו. אנא נסו שוב.',
  },
  invalidPreviousRules: {
    en: 'Something went wrong with this request. Please try again.',
    he: 'משהו השתבש בבקשה הזו. אנא נסו שוב.',
  },
  invalidProblems: {
    en: 'Something went wrong with this request. Please try again.',
    he: 'משהו השתבש בבקשה הזו. אנא נסו שוב.',
  },
  invalidLearnId: {
    en: 'This learning session has expired. Please start again.',
    he: 'פג תוקף הלמידה הזו. אנא התחילו מחדש.',
  },
  invalidRows: {
    en: 'Something went wrong with this request. Please try again.',
    he: 'משהו השתבש בבקשה הזו. אנא נסו שוב.',
  },
  invalidRounds: {
    en: 'Something went wrong with this request. Please try again.',
    he: 'משהו השתבש בבקשה הזו. אנא נסו שוב.',
  },
  turnstileFailed: {
    en: "We couldn't confirm you're not a robot. Refresh the page and try again.",
    he: 'לא הצלחנו לוודא שאתם לא רובוט. רעננו את הדף ונסו שוב.',
  },
  limitHit: {
    en: "You've reached a limit. Sign in or come back later to keep going.",
    he: 'הגעתם למגבלה. התחברו או חזרו מאוחר יותר כדי להמשיך.',
  },
  anonBudgetExhausted: {
    en: 'Sign in to keep going.',
    he: 'התחברו כדי להמשיך.',
  },
  budgetExhausted: {
    en: "We've reached our limit for today. Please try again tomorrow.",
    he: 'הגענו למגבלה להיום. אנא נסו שוב מחר.',
  },
  rateLimited: {
    en: 'Too many requests. Wait a minute and try again.',
    he: 'יותר מדי בקשות. המתינו דקה ונסו שוב.',
  },
  // SPEC 21 v5: the AI step needs a sign-in. The UI puts the local result first and adds the counts
  // ("We worked out N of M columns ... K need the AI step"); the number of AI learns comes from config.
  signInForAi: {
    en: 'Sign in free to finish this with the AI step.',
    he: 'התחברו בחינם כדי להשלים את זה בעזרת שלב ה-AI.',
  },
  // The version for an answer that did not count anything (a further try on a pair that already stopped).
  // The one that counted a learn is `aiAttemptsExhaustedMessages.counted`.
  aiAttemptsExhausted: {
    en: "We already tried this pair of files several times and the result still didn't match your example. Check that the output was made from this exact input and that its hand edits are marked, then start again with the corrected files.",
    he: 'כבר ניסינו את זוג הקבצים הזה כמה פעמים והתוצאה עדיין לא תאמה לדוגמה שלכם. בדקו שהפלט נוצר בדיוק מקובץ הקלט הזה ושסימנתם את השורות שתוקנו ידנית, והתחילו מחדש עם הקבצים המתוקנים.',
  },
  signInRequired: {
    en: 'Sign in to save formats and use them again.',
    he: 'התחברו כדי לשמור פורמטים ולהשתמש בהם שוב.',
  },
  notFound: {
    en: "We couldn't find that. It may have been deleted.",
    he: 'לא מצאנו את זה. ייתכן שזה נמחק.',
  },
  invalidRequest: {
    en: 'Something went wrong with this request. Please try again.',
    he: 'משהו השתבש בבקשה הזו. אנא נסו שוב.',
  },
  invalidRules: {
    en: "These rules can't be saved yet. Fix the marked problems and try again.",
    he: 'אי אפשר לשמור את הכללים האלה עדיין. תקנו את הבעיות המסומנות ונסו שוב.',
  },
  rulesTooLarge: {
    en: "This format is too large to save: a list, a value or a title in its rules is longer than a saved format may keep. Shorten it and try again.",
    he: 'הפורמט הזה גדול מדי לשמירה: רשימה, ערך או כותרת בכללים שלו ארוכים יותר ממה שפורמט שמור יכול להכיל. קצרו אותם ונסו שוב.',
  },
  formatMismatch: {
    en: "This file's output doesn't match the format. See which columns differ and fix them, or save it as a new format.",
    he: 'הפלט של הקובץ הזה לא תואם לפורמט. ראו אילו עמודות שונות ותקנו אותן, או שמרו אותו כפורמט חדש.',
  },
  nameTaken: {
    en: 'You already have a source with that name. Choose a different name.',
    he: 'כבר יש לכם מקור בשם הזה. בחרו שם אחר.',
  },
  // SPEC 8.15: the conversion's input side has to match its source (the source lock).
  sourceMismatch: {
    en: "This file's columns don't match the source it belongs to. See which columns differ and fix them, or save it as a new source.",
    he: 'העמודות של הקובץ הזה לא תואמות למקור שאליו הוא שייך. ראו אילו עמודות שונות ותקנו אותן, או שמרו אותו כמקור חדש.',
  },
  sourceInUse: {
    en: 'This source still feeds a format. Remove it from its formats first.',
    he: 'המקור הזה עדיין מזין פורמט. הסירו אותו מהפורמטים שלו קודם.',
  },
  aliasConflict: {
    en: 'That column name is already used for a different column in this source.',
    he: 'שם העמודה הזה כבר משמש עמודה אחרת במקור הזה.',
  },
  versionConflict: {
    en: 'This was changed somewhere else in the meantime. Reload it and try again.',
    he: 'זה שונה בינתיים במקום אחר. טענו מחדש ונסו שוב.',
  },
  unavailable: {
    en: 'Saving is not available right now. Please try again later.',
    he: 'השמירה לא זמינה כרגע. אנא נסו שוב מאוחר יותר.',
  },
  forbidden: {
    en: 'This page is for admins only.',
    he: 'הדף הזה מיועד למנהלים בלבד.',
  },
};

// SPEC 21 v5 item 3: what the user is told when the failed-attempt cap is reached. `counted` = this answer
// is the one that counted the pair as one AI learn.
export const aiAttemptsExhaustedMessages: Record<'counted' | 'notCounted', Localized> = {
  counted: {
    en: "We tried this pair of files several times and the result still didn't match your example. This counted as one AI learn. Check that the output was made from this exact input and that its hand edits are marked, then start again with the corrected files.",
    he: 'ניסינו את זוג הקבצים הזה כמה פעמים והתוצאה עדיין לא תאמה לדוגמה שלכם. זה נספר כלמידת AI אחת. בדקו שהפלט נוצר בדיוק מקובץ הקלט הזה ושסימנתם את השורות שתוקנו ידנית, והתחילו מחדש עם הקבצים המתוקנים.',
  },
  notCounted: {
    en: "We already tried this pair of files several times and the result still didn't match your example. Check that the output was made from this exact input and that its hand edits are marked, then start again with the corrected files.",
    he: 'כבר ניסינו את זוג הקבצים הזה כמה פעמים והתוצאה עדיין לא תאמה לדוגמה שלכם. בדקו שהפלט נוצר בדיוק מקובץ הקלט הזה ושסימנתם את השורות שתוקנו ידנית, והתחילו מחדש עם הקבצים המתוקנים.',
  },
};

// Text for each `limitHit { limit }` (SPEC 11).
export const limitMessages: Record<LimitCode, Localized> = {
  learnsPerDay: {
    en: "You've used today's free tries. Come back tomorrow, or sign in to keep going.",
    he: 'ניצלתם את הניסיונות החינמיים להיום. אפשר לחזור מחר, או להתחבר כדי להמשיך.',
  },
  learnsPerMonth: {
    en: "You've used all your learns for this month.",
    he: 'ניצלתם את כל הלמידות של החודש.',
  },
  repairsPerLearn: {
    en: 'We already tried every extra fix for this one.',
    he: 'כבר ניסינו את כל התיקונים הנוספים עבור הלמידה הזו.',
  },
  stepsPerLearn: {
    en: 'The AI already checked every idea it may for this learn.',
    he: 'ה-AI כבר בדק את כל הרעיונות שמותר לו בלמידה הזו.',
  },
  // SPEC 21 v5: generic text; `aiLearnsLimitMessages` has one per `period`.
  aiLearns: {
    en: "You've used all your AI learns for now.",
    he: 'ניצלתם את כל למידות ה-AI שלכם לעכשיו.',
  },
  savedFormats: {
    en: "You've saved as many formats as your plan allows. Delete one to make room.",
    he: 'שמרתם את מספר הפורמטים המרבי שהתוכנית שלכם מאפשרת. מחקו אחד כדי לפנות מקום.',
  },
  newFormatsPerMonth: {
    en: "You've created all the new formats your plan allows this month.",
    he: 'יצרתם את כל הפורמטים החדשים שהתוכנית שלכם מאפשרת החודש.',
  },
  sourcesPerFormat: {
    en: "This format already has as many sources as your plan allows.",
    he: 'לפורמט הזה כבר יש את מספר המקורות המרבי שהתוכנית שלכם מאפשרת.',
  },
  rulesPerFormat: {
    en: 'This format has more rules than your plan allows. Simplify it, or upgrade.',
    he: 'בפורמט הזה יש יותר כללים ממה שהתוכנית שלכם מאפשרת. פשטו אותו או שדרגו.',
  },
};

// SPEC 21 v5: the text for `limitHit { limit: 'aiLearns', period }`, by the period the quota is counted over.
export const aiLearnsLimitMessages: Record<Exclude<AiLearnPeriod, 'unlimited'>, Localized> = {
  lifetime: {
    en: "You've used all your AI learns.",
    he: 'ניצלתם את כל למידות ה-AI שלכם.',
  },
  month: {
    en: "You've used all your AI learns for this month. They come back next month.",
    he: 'ניצלתם את כל למידות ה-AI של החודש. הן יתחדשו בחודש הבא.',
  },
  day: {
    en: "You've used all your AI learns for today. They come back tomorrow.",
    he: 'ניצלתם את כל למידות ה-AI של היום. הן יתחדשו מחר.',
  },
};
