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

import { convertEn, convertHe } from './convert';
import { accountEn, accountHe } from './account';
import { adminEn, adminHe } from './admin';
import { formatsEn, formatsHe } from './formats';
import { pagesEn, pagesHe } from './pages';
import { resultEn, resultHe } from './result';

export const en = {
  ...resultEn,
  ...accountEn,
  ...adminEn,
  ...formatsEn,
  ...convertEn,
  ...pagesEn,
  'app.name': 'formatAI',
  'app.tagline': 'Teach a format once. Use it every month.',

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

  // ---------- M2 app shell and first screens ----------
  'common.close': 'Close',
  'common.copy': 'Copy',
  'common.copied': 'Copied',

  'skip.toMain': 'Skip to content',
  'header.signIn': 'Sign in',
  'footer.label': 'About formatAI',
  'footer.business': 'Business',
  'footer.privacy': 'Privacy',
  'footer.terms': 'Terms',

  // SPEC 5 E: the sign-in wall
  'signIn.title': 'Sign in',
  'signIn.save': "Sign in to save this format and reuse it on next month's file.",
  'signIn.download': 'Sign in free to download the full file.',
  'signIn.keepGoing': 'Sign in to keep going.',
  'signIn.kept': 'What you have learned survives signing in, so nothing has to be redone.',
  'signIn.google': 'Continue with Google',
  'signIn.microsoft': 'Continue with Microsoft',

  'steps.label': 'Steps',
  'steps.upload': 'Upload',
  'steps.learn': 'Learn',
  'steps.use': 'Use',

  // SPEC 16.1 screen 1: Home is the tool
  'home.title': 'Show us one example',
  'home.lead': 'Add a file as it arrives and the same data the way you want it. We will learn the format.',
  'home.input.title': 'Example input',
  'home.input.caption': 'A file as it arrives',
  'home.output.title': 'Example output',
  'home.output.caption': 'The same data, the way you want it',
  'home.learn': 'Learn the format',
  'home.learnAi': 'Learn with AI',
  'home.learnAi.guest': 'Sign in free to learn with AI ({included}).',
  'home.needFiles': 'Add both files to continue.',
  'home.how.title': 'How it works',
  'home.how.1.title': 'Show one example',
  'home.how.1.text': 'Drop a file as it arrives and the result you want from it.',
  'home.how.2.title': 'Check the rules',
  'home.how.2.text': 'We write the rules in plain words. You see what matches and fix what does not.',
  'home.how.3.title': 'Use it every month',
  'home.how.3.text': 'Drop the next file. Same rules, same result, every value checked.',

  'dropzone.drop': 'Drop a file here or',
  'dropzone.browse': 'browse',
  'dropzone.release': 'Release to add this file',
  'dropzone.dropMany': 'Drop files here or',
  'dropzone.releaseMany': 'Release to add these files',
  'dropzone.reading': 'Reading…',
  'dropzone.replace': 'Click or drop another file to replace it',
  'dropzone.remove': 'Remove {label}',
  'file.rows.one': '1 row',
  'file.rows.other': '{rows} rows',
  'file.columns.one': '1 column',
  'file.columns.other': '{columns} columns',
  'file.size': '{kb} KB',
  'error.cannotRead': "We couldn't read this file. Check that it isn't damaged or locked with a password, then choose it again.",

  'masking.difference': "What's the difference?",
  'masking.panelTitle': 'Masking: on, off, and always',
  'masking.state.on': 'On',
  'masking.state.off': 'Off',
  'masking.state.always': 'Always',

  // SPEC 15: "See what we send"
  'sendPanel.lead.before': 'Only a small summary of your files is sent, never the files. When you press "Learn the format", this is what goes:',
  'sendPanel.item.columns': 'Column names, and a profile of each column: its type, its shape and how many cells are empty.',
  'sendPanel.item.rows.on': 'Up to 12 sample rows. Names, ID numbers and other text are replaced with look-alike values first.',
  'sendPanel.item.rows.off': 'Up to 12 sample rows, exactly as they are.',
  'sendPanel.item.hints': 'What your computer already worked out: which columns are copied, reformatted or calculated.',
  // AI code checks (SPEC 21 v14): before it answers, the AI step may ask code to check ideas on every row.
  'sendPanel.item.checks': 'If the AI asks to check an idea first, your computer answers with counts and ranges from your example, and at most a few more rows, sent like the sample rows (within the same {rows} rows).',
  'sendPanel.item.loop': 'If the rules then get rows of your example wrong: up to {rounds} more requests, each with some of those rows (at most {rows} rows in all), sent like the sample rows.',
  'sendPanel.note.before': 'If your computer can solve it alone, nothing is sent at all. When something is sent, the exact data appears here.',
  'sendPanel.lead.sent': 'This is exactly what was sent.',
  'sendPanel.kind.learn': 'Learn request',
  'sendPanel.kind.repair': 'Fix request',
  'sendPanel.kind.round': 'Fix request, round {n} of {of}',
  // A round of the learning loop sent as a new learn: the result came from an earlier learn of files laid out the same way (no learn to fix).
  'sendPanel.kind.fresh': 'New learn request, instead of fix round {n} of {of}',
  'sendPanel.fresh.note': 'Rules from an earlier learn of files laid out like these did not match every row of your example, so the AI learns again from the start. This request carries the same summary and nothing else: no rules, no rows it got wrong.',
  'sendPanel.rows.one': 'It carries 1 row of your example the rules got wrong (every row sent so far).',
  'sendPanel.rows.other': 'It carries {n} rows of your example the rules got wrong (every row sent so far).',
  // A step of AI code checks: the checks the AI asked and your computer's answers, every round so far.
  'sendPanel.kind.step': "Answers to the AI's checks, round {n} of {of}",
  'sendPanel.checkRows.one': 'Its answers show 1 row of your example (every row the checks showed so far).',
  'sendPanel.checkRows.other': 'Its answers show {n} rows of your example (every row the checks showed so far).',
  'sendPanel.json': 'Data sent (JSON)',
  'sendPanel.columns.title': 'Your columns in the rows we send',
  'sendPanel.columns.input': 'Example input',
  'sendPanel.columns.output': 'Example output',
  'sendPanel.columns.hidden': '{column}: values hidden (replaced with look-alike values)',
  'sendPanel.columns.sent': '{column}: values sent as they are',

  // SPEC 16.1 screen 2: pre-flight
  'preflight.warnTitle': 'One thing to check first',
  'learning.unexplained.lead': 'Columns we could not find in your input file',
  'preflight.tryAnywayNote': 'Trying anyway counts as a learn.',
  'preflight.changeFiles': 'Choose other files',
  'preflight.side.input': 'the example input',
  'preflight.side.output': 'the example output',
  'preflight.table.noHeaderRow': 'In {side}, we could not find a row of column names near the top. Add a header row and upload the file again.',
  'preflight.table.multipleTables': 'In {side}, the sheet holds more than one table. Keep one table on the sheet and upload the file again.',
  'preflight.table.mergedHeader': 'In {side}, row {row} has cells merged across columns {fromCol}–{toCol}. Unmerge them and upload the file again.',
  'preflight.table.splitHeader': 'In {side}, the column names are split over two rows. Put them in one row and upload the file again.',
  'preflight.table.tooFewDataRows': 'In {side}, there are fewer than 2 rows of data. Add more rows and upload the file again.',
  'preflight.table.onlyDrawings': 'In {side}, the sheet has only charts or images and no table. Use a sheet with a table and upload the file again.',
  'preflight.table.emptySheet': 'In {side}, the sheet is empty. Choose a file with data in it.',
  'preflight.todo.rowExpansionUnsupported': 'Use an example where each input row becomes one output row, then try again.',
  'preflight.todo.pivotDetected': 'Use an example output that keeps those values as rows, then try again.',
  'preflight.todo.noColumnTraced': 'Check that one file is the input and the other is the output made from it, then choose them again.',
  'preflight.todo.identicalFiles': 'Choose an output file that was changed from the input.',
  'preflight.overTier.rows': 'Your file has {value} rows, and the free plan allows up to {limit}. Use a smaller file, or sign in for a higher limit.',
  'preflight.overTier.columns': 'Your file has {value} columns, and the free plan allows up to {limit}. Remove the columns you do not need, or sign in for a higher limit.',

  // SPEC 16.1 screen 3: learning progress
  'learning.title': 'Learning your format',
  'learning.wait': 'This can take a little while.',
  // The learning loop (SPEC 9.3): each round, under the step that fixes what did not match.
  'learning.round.one': 'Checking every row of your example: sending 1 row the rules got wrong (round {n} of {of}).',
  'learning.round.other': 'Checking every row of your example: sending {rows} rows the rules got wrong (round {n} of {of}).',
  'learning.round.none': 'Checking every row of your example: sending what still did not match (round {n} of {of}).',
  'learning.round.list': 'Looking for the rule behind a list of fixed values (round {n} of {of}).',
  // AI code checks (SPEC 21 v14): the AI step asked code to check an idea on every row before it answers.
  'learning.checks': 'The AI is checking an idea on your rows (round {n} of {of}).',
  'learning.done': 'Done',

  'error.tryAgain': 'Try again',
  'error.changeFiles': 'Change files',
  'error.reload': 'Refresh the page',
  'error.retryAfter': 'You can try again in {seconds} seconds.',

  'result.startOver': 'Start over',
} as const satisfies Record<string, string>;

export type MessageKey = keyof typeof en;

export const he: Record<MessageKey, string> = {
  ...resultHe,
  ...accountHe,
  ...adminHe,
  ...formatsHe,
  ...convertHe,
  ...pagesHe,
  'app.name': 'formatAI',
  'app.tagline': 'מלמדים פורמט פעם אחת. משתמשים בו כל חודש.',

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

  // ---------- M2 app shell and first screens ----------
  'common.close': 'סגירה',
  'common.copy': 'העתקה',
  'common.copied': 'הועתק',

  'skip.toMain': 'דלגו לתוכן',
  'header.signIn': 'התחברות',
  'footer.label': 'אודות formatAI',
  'footer.business': 'לעסקים',
  'footer.privacy': 'פרטיות',
  'footer.terms': 'תנאי שימוש',

  'signIn.title': 'התחברות',
  'signIn.save': 'התחברו כדי לשמור את הפורמט הזה ולהשתמש בו בקובץ של החודש הבא.',
  'signIn.download': 'התחברו בחינם כדי להוריד את הקובץ המלא.',
  'signIn.keepGoing': 'התחברו כדי להמשיך.',
  'signIn.kept': 'מה שכבר נלמד נשמר גם אחרי ההתחברות, כך שלא צריך לעשות שוב כלום.',
  'signIn.google': 'המשך עם Google',
  'signIn.microsoft': 'המשך עם Microsoft',

  'steps.label': 'שלבים',
  'steps.upload': 'העלאה',
  'steps.learn': 'למידה',
  'steps.use': 'שימוש',

  'home.title': 'הראו לנו דוגמה אחת',
  'home.lead': 'הוסיפו קובץ כפי שהוא מגיע, ואת אותם נתונים כפי שאתם רוצים אותם. אנחנו נלמד את הפורמט.',
  'home.input.title': 'דוגמת קלט',
  'home.input.caption': 'קובץ כפי שהוא מגיע',
  'home.output.title': 'דוגמת פלט',
  'home.output.caption': 'אותם נתונים, כפי שאתם רוצים אותם',
  'home.learn': 'ללמוד את הפורמט',
  'home.learnAi': 'ללמוד עם AI',
  'home.learnAi.guest': 'התחברו בחינם כדי ללמוד עם AI ({included}).',
  'home.needFiles': 'הוסיפו את שני הקבצים כדי להמשיך.',
  'home.how.title': 'איך זה עובד',
  'home.how.1.title': 'מראים דוגמה אחת',
  'home.how.1.text': 'מעלים קובץ כפי שהוא מגיע ואת התוצאה שרוצים ממנו.',
  'home.how.2.title': 'בודקים את הכללים',
  'home.how.2.text': 'אנחנו כותבים את הכללים במילים פשוטות. רואים מה מתאים ומתקנים מה שלא.',
  'home.how.3.title': 'משתמשים בו כל חודש',
  'home.how.3.text': 'מעלים את הקובץ הבא. אותם כללים, אותה תוצאה, וכל ערך נבדק.',

  'dropzone.drop': 'גררו קובץ לכאן או',
  'dropzone.browse': 'בחרו מהמחשב',
  'dropzone.release': 'שחררו כדי להוסיף את הקובץ',
  'dropzone.dropMany': 'גררו קבצים לכאן או',
  'dropzone.releaseMany': 'שחררו כדי להוסיף את הקבצים',
  'dropzone.reading': 'קוראים…',
  'dropzone.replace': 'לחצו או גררו קובץ אחר כדי להחליף',
  'dropzone.remove': 'הסרת {label}',
  'file.rows.one': 'שורה אחת',
  'file.rows.other': '{rows} שורות',
  'file.columns.one': 'עמודה אחת',
  'file.columns.other': '{columns} עמודות',
  'file.size': '{kb} ק״ב',
  'error.cannotRead': 'לא הצלחנו לקרוא את הקובץ הזה. בדקו שהוא לא פגום ולא נעול בסיסמה, ובחרו אותו שוב.',

  'masking.difference': 'מה ההבדל?',
  'masking.panelTitle': 'הסתרת נתונים: פועלת, כבויה ותמיד',
  'masking.state.on': 'פועלת',
  'masking.state.off': 'כבויה',
  'masking.state.always': 'תמיד',

  'sendPanel.lead.before': 'נשלח רק סיכום קטן של הקבצים, לעולם לא הקבצים עצמם. כשלוחצים על "ללמוד את הפורמט", זה מה שיוצא:',
  'sendPanel.item.columns': 'שמות העמודות ופרופיל של כל עמודה: הסוג, הצורה וכמה תאים ריקים.',
  'sendPanel.item.rows.on': 'עד 12 שורות דוגמה. שמות, מספרי זהות וטקסט אחר מוחלפים קודם בערכים מדומים.',
  'sendPanel.item.rows.off': 'עד 12 שורות דוגמה, בדיוק כפי שהן.',
  'sendPanel.item.hints': 'מה שהמחשב שלך כבר הבין: אילו עמודות מועתקות, מעוצבות מחדש או מחושבות.',
  'sendPanel.item.checks': 'אם ה-AI מבקש קודם לבדוק רעיון, המחשב שלכם עונה בספירות ובטווחים מתוך הדוגמה שלכם, ולכל היותר בעוד כמה שורות, שנשלחות כמו שורות הדוגמה (בתוך אותן {rows} שורות).',
  'sendPanel.item.loop': 'אם הכללים טועים בשורות מהדוגמה שלכם: עד {rounds} בקשות נוספות, בכל אחת חלק מהשורות האלה (עד {rows} שורות בסך הכול), שנשלחות כמו שורות הדוגמה.',
  'sendPanel.note.before': 'אם המחשב שלך יכול לפתור את זה לבד, לא נשלח דבר. כשנשלח משהו, הנתונים המדויקים מופיעים כאן.',
  'sendPanel.lead.sent': 'זה בדיוק מה שנשלח.',
  'sendPanel.kind.learn': 'בקשת למידה',
  'sendPanel.kind.repair': 'בקשת תיקון',
  'sendPanel.kind.round': 'בקשת תיקון, סבב {n} מתוך {of}',
  'sendPanel.kind.fresh': 'בקשת למידה חדשה, במקום סבב תיקון {n} מתוך {of}',
  'sendPanel.fresh.note': 'כללים מלמידה קודמת של קבצים באותו מבנה לא התאימו לכל שורה בדוגמה שלכם, ולכן ה-AI לומד מחדש מההתחלה. הבקשה הזו כוללת את אותו סיכום ותו לא: בלי כללים ובלי שורות שהם טעו בהן.',
  'sendPanel.rows.one': 'היא כוללת שורה אחת מהדוגמה שלכם שהכללים טעו בה (כל השורות שנשלחו עד כה).',
  'sendPanel.rows.other': 'היא כוללת {n} שורות מהדוגמה שלכם שהכללים טעו בהן (כל השורות שנשלחו עד כה).',
  'sendPanel.kind.step': 'תשובות לבדיקות של ה-AI, סבב {n} מתוך {of}',
  'sendPanel.checkRows.one': 'התשובות בה מציגות שורה אחת מהדוגמה שלכם (כל השורות שהבדיקות הציגו עד כה).',
  'sendPanel.checkRows.other': 'התשובות בה מציגות {n} שורות מהדוגמה שלכם (כל השורות שהבדיקות הציגו עד כה).',
  'sendPanel.json': 'הנתונים שנשלחו (JSON)',
  'sendPanel.columns.title': 'העמודות שלכם בשורות שאנחנו שולחים',
  'sendPanel.columns.input': 'דוגמת קלט',
  'sendPanel.columns.output': 'דוגמת פלט',
  'sendPanel.columns.hidden': '{column}: הערכים מוסתרים (מוחלפים בערכים מדומים)',
  'sendPanel.columns.sent': '{column}: הערכים נשלחים כפי שהם',

  'preflight.warnTitle': 'דבר אחד לבדוק קודם',
  'learning.unexplained.lead': 'עמודות שלא מצאנו בקובץ הקלט שלכם',
  'preflight.tryAnywayNote': 'ניסיון בכל זאת נחשב ללמידה.',
  'preflight.changeFiles': 'בחירת קבצים אחרים',
  'preflight.side.input': 'קובץ הקלט לדוגמה',
  'preflight.side.output': 'קובץ הפלט לדוגמה',
  'preflight.table.noHeaderRow': 'ב{side} לא מצאנו שורת כותרות בחלק העליון. הוסיפו שורת כותרות והעלו את הקובץ שוב.',
  'preflight.table.multipleTables': 'ב{side} יש בגיליון יותר מטבלה אחת. השאירו בגיליון טבלה אחת והעלו את הקובץ שוב.',
  'preflight.table.mergedHeader': 'ב{side} בשורה {row} יש תאים ממוזגים בעמודות {fromCol}–{toCol}. בטלו את המיזוג והעלו את הקובץ שוב.',
  'preflight.table.splitHeader': 'ב{side} שמות העמודות מפוצלים על פני שתי שורות. העבירו אותם לשורה אחת והעלו את הקובץ שוב.',
  'preflight.table.tooFewDataRows': 'ב{side} יש פחות משתי שורות נתונים. הוסיפו שורות והעלו את הקובץ שוב.',
  'preflight.table.onlyDrawings': 'ב{side} בגיליון יש רק תרשימים או תמונות ואין טבלה. השתמשו בגיליון עם טבלה והעלו את הקובץ שוב.',
  'preflight.table.emptySheet': 'ב{side} הגיליון ריק. בחרו קובץ שיש בו נתונים.',
  'preflight.todo.rowExpansionUnsupported': 'השתמשו בדוגמה שבה כל שורת קלט הופכת לשורת פלט אחת, ונסו שוב.',
  'preflight.todo.pivotDetected': 'השתמשו בדוגמת פלט שבה הערכים האלה נשארים שורות, ונסו שוב.',
  'preflight.todo.noColumnTraced': 'בדקו שקובץ אחד הוא הקלט והשני הוא הפלט שנוצר ממנו, ובחרו אותם שוב.',
  'preflight.todo.identicalFiles': 'בחרו קובץ פלט ששונה ביחס לקלט.',
  'preflight.overTier.rows': 'בקובץ שלכם {value} שורות, והתוכנית החינמית מאפשרת עד {limit}. השתמשו בקובץ קטן יותר, או התחברו כדי לקבל מגבלה גבוהה יותר.',
  'preflight.overTier.columns': 'בקובץ שלכם {value} עמודות, והתוכנית החינמית מאפשרת עד {limit}. הסירו עמודות שאתם לא צריכים, או התחברו כדי לקבל מגבלה גבוהה יותר.',

  'learning.title': 'לומדים את הפורמט שלכם',
  'learning.wait': 'זה עשוי לקחת קצת זמן.',
  'learning.round.one': 'בודקים כל שורה בדוגמה שלכם: שולחים שורה אחת שהכללים טעו בה (סבב {n} מתוך {of}).',
  'learning.round.other': 'בודקים כל שורה בדוגמה שלכם: שולחים {rows} שורות שהכללים טעו בהן (סבב {n} מתוך {of}).',
  'learning.round.none': 'בודקים כל שורה בדוגמה שלכם: שולחים את מה שעדיין לא התאים (סבב {n} מתוך {of}).',
  'learning.round.list': 'מחפשים את הכלל שמאחורי רשימה של ערכים קבועים (סבב {n} מתוך {of}).',
  'learning.checks': 'ה-AI בודק רעיון מול השורות שלכם (סבב {n} מתוך {of}).',
  'learning.done': 'הושלם',

  'error.tryAgain': 'נסו שוב',
  'error.changeFiles': 'החלפת קבצים',
  'error.reload': 'רענון הדף',
  'error.retryAfter': 'אפשר לנסות שוב בעוד {seconds} שניות.',

  'result.startOver': 'להתחיל מחדש',
};
