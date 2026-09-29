// Plain-language he/en text for every unsupported and assumption code (SPEC 8.10,
// tone per SPEC 16.3: no jargon, say exactly what's true and what the user can do).
// The LLM never writes UI text (SPEC 16.2); this dictionary is the only source of it.
import type { AssumptionReasonCode, UnsupportedReasonCode } from '../codes';

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
  other: {
    en: 'We made a guess here. Please check it.',
    he: 'ניחשנו כאן משהו. אנא בדקו.',
  },
};
