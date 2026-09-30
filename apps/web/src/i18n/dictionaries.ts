// App UI strings, Hebrew and English (SPEC 16.2: the whole UI from day one). This is
// the START of the dictionary: only what the plumbing and the debug page need. Texts for
// unsupported/assumption/pre-flight/flag codes are NOT here: they already live in
// packages/shared (`unsupportedMessages`, `preflightBlockMessages`, ...) and are used
// through `useI18n().code(...)`.
//
// Adding a key: add it to `en` first; `he` is typed as `Record<MessageKey, string>`, so
// the compiler refuses a build with a missing Hebrew string. `{name}` placeholders are
// filled from the params of `t(key, params)`.
//
// Tone (SPEC 16.3): plain words, say exactly what happened and what to do.

export const en = {
  'app.name': 'formatAI',
  'app.tagline': 'Teach a format once. Use it every month.',

  'lang.toggle.label': 'Language',
  'lang.name.en': 'English',
  'lang.name.he': 'עברית',
  'lang.switchTo.en': 'Switch to English',
  'lang.switchTo.he': 'עבור לעברית',

  // SPEC 7.2 UI copy
  'masking.label': 'Masking',
  'masking.on':
    'Masking on: names, ID numbers and other text in the sample rows are replaced with look-alike values before anything leaves your computer. Numbers, dates and column names are sent as they are.',
  'masking.off':
    'Masking off: up to 12 sample rows are sent as they are. Learning is more accurate when a column is built from part of a text value, like the first digits of a policy number.',
  'masking.always': 'Your full files never leave your computer.',

  // SPEC 16.1 "Learning progress"
  'flow.reading': 'Reading files',
  'flow.checking': 'Checking the files',
  'flow.learning': 'Learning the format',
  'flow.learningRepair': 'Fixing what did not match',
  'flow.verifying': 'Checking against your example',

  'flow.path.local': 'Solved on your computer',
  'flow.path.llm': 'Learned with help from the server',
  'flow.status.verified': 'Verified',
  'flow.status.notVerified': 'Not fully matching your example',
  'flow.blocked': "We can't learn from these files",
  'flow.warn.continue': 'Continue',
  'flow.warn.tryAnyway': 'Try anyway',
  'flow.cancel': 'Cancel',

  'sendPanel.title': 'See what we send',
  'sendPanel.empty': 'Nothing has been sent.',
  'sendPanel.size': '{kb} KB',

  // Errors: what happened, what to do.
  'error.fileTooLarge': 'This file is too large ({mb} MB). Files can be up to {maxMb} MB.',
  'error.unsupportedFileType': 'We can read .xlsx, .xls, .csv and .txt files. Choose one of those.',
  'error.timeout': 'Reading this file took too long, so we stopped. Try a smaller file.',
  'error.workerCrashed': 'Something went wrong while reading the file. Try again.',
  'error.network': "We couldn't reach the server. Check your connection and try again.",
  'error.server': 'The server had a problem. Try again in a moment.',
  'error.payloadTooLarge': 'The learning request is too large for the server.',
  'error.learnFailed': "We couldn't learn a format from these files. Check that they are the right two files.",
  'error.unexpected': 'Something unexpected happened. Try again.',

  'convert.title': 'Convert a file',
  'convert.noRules': 'Learn a format first.',
  'convert.download': 'Download',
  'convert.rowsIn': 'Rows in',
  'convert.rowsOut': 'Rows out',
  'convert.flags': 'Rows to check',
  'convert.missingColumns': 'These columns are missing from the file: {columns}',
  'convert.noTable': "We couldn't find a table in this file.",
} as const satisfies Record<string, string>;

export type MessageKey = keyof typeof en;

export const he: Record<MessageKey, string> = {
  'app.name': 'formatAI',
  'app.tagline': 'מלמדים פורמט פעם אחת. משתמשים בו כל חודש.',

  'lang.toggle.label': 'שפה',
  'lang.name.en': 'English',
  'lang.name.he': 'עברית',
  'lang.switchTo.en': 'Switch to English',
  'lang.switchTo.he': 'עבור לעברית',

  'masking.label': 'הסתרת נתונים',
  'masking.on':
    'הסתרת נתונים פועלת: שמות, מספרי זהות וטקסט בשורות הדוגמה מוחלפים בערכים מדומים לפני שהם יוצאים מהמחשב שלך. מספרים, תאריכים ושמות העמודות נשלחים כפי שהם.',
  'masking.off':
    'הסתרת נתונים כבויה: עד 12 שורות דוגמה נשלחות כפי שהן. הלמידה מדויקת יותר כשעמודה נבנית מחלק של ערך טקסט, למשל הספרות הראשונות של מספר פוליסה.',
  'masking.always': 'הקבצים המלאים לעולם לא יוצאים מהמחשב שלך.',

  'flow.reading': 'קוראים את הקבצים',
  'flow.checking': 'בודקים את הקבצים',
  'flow.learning': 'לומדים את הפורמט',
  'flow.learningRepair': 'מתקנים את מה שלא התאים',
  'flow.verifying': 'בודקים מול הדוגמה שלך',

  'flow.path.local': 'נפתר במחשב שלך',
  'flow.path.llm': 'נלמד בעזרת השרת',
  'flow.status.verified': 'מאומת',
  'flow.status.notVerified': 'לא תואם במלואו לדוגמה שלך',
  'flow.blocked': 'אי אפשר ללמוד מהקבצים האלה',
  'flow.warn.continue': 'המשך',
  'flow.warn.tryAnyway': 'נסו בכל זאת',
  'flow.cancel': 'ביטול',

  'sendPanel.title': 'מה אנחנו שולחים',
  'sendPanel.empty': 'לא נשלח דבר.',
  'sendPanel.size': '{kb} ק״ב',

  'error.fileTooLarge': 'הקובץ הזה גדול מדי ({mb} מ״ב). אפשר להעלות קבצים עד {maxMb} מ״ב.',
  'error.unsupportedFileType': 'אנחנו קוראים קבצים מסוג xlsx, xls, csv ו-txt. בחרו קובץ מאחד הסוגים האלה.',
  'error.timeout': 'קריאת הקובץ נמשכה יותר מדי זמן ולכן עצרנו. נסו קובץ קטן יותר.',
  'error.workerCrashed': 'משהו השתבש בקריאת הקובץ. נסו שוב.',
  'error.network': 'לא הצלחנו להתחבר לשרת. בדקו את החיבור ונסו שוב.',
  'error.server': 'הייתה בעיה בשרת. נסו שוב בעוד רגע.',
  'error.payloadTooLarge': 'בקשת הלמידה גדולה מדי עבור השרת.',
  'error.learnFailed': 'לא הצלחנו ללמוד פורמט מהקבצים האלה. בדקו שאלה שני הקבצים הנכונים.',
  'error.unexpected': 'קרה משהו לא צפוי. נסו שוב.',

  'convert.title': 'המרת קובץ',
  'convert.noRules': 'קודם ללמוד פורמט.',
  'convert.download': 'הורדה',
  'convert.rowsIn': 'שורות בקלט',
  'convert.rowsOut': 'שורות בפלט',
  'convert.flags': 'שורות לבדיקה',
  'convert.missingColumns': 'העמודות האלה חסרות בקובץ: {columns}',
  'convert.noTable': 'לא מצאנו טבלה בקובץ הזה.',
};
