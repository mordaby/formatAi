// Plain-language he/en text for every unsupported and assumption code (SPEC 8.10,
// tone per SPEC 16.3: no jargon, say exactly what's true and what the user can do).
// The LLM never writes UI text (SPEC 16.2); this dictionary is the only source of it.
import type {
  AssumptionReasonCode,
  FlagMessageKey,
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
    en: "These columns have values that don't appear in your input file. They probably come from another source, which isn't supported yet. We'll learn everything else and leave these empty.",
    he: 'לעמודות האלה יש ערכים שלא מופיעים בקובץ הקלט שלכם. הם כנראה מגיעים ממקור אחר, ואפשרות זו עדיין לא נתמכת. נלמד את כל השאר ונשאיר את אלה ריקות.',
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
};
