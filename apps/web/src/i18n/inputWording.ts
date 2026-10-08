// The wording while "Formats with several sources" is OFF (owner decision 2026-10-07: users never meet the word "source" unless it is on).
// A format is the output; each kind of input file that makes it has its own rules, kept as a "source" behind the scenes - so wherever the app
// can show one with the switch off (the Run screen, the format page, the editor, messages and errors, the public pages), it is "an input
// file", never "a source". `FeaturesProvider` puts these over the dictionaries while the switch is off (app/Features.tsx); on, the app says
// what it always said.
//
// Every message whose text says "source" / "מקור" is either here or in `SOURCE_UI_ONLY` (shown only by the explicit source UI the switch
// hides) - a test holds that (i18n.test.tsx "the input wording").
import type { ApiErrorCode, LimitCode, PreflightWarnReason } from '@formatai/shared';
import type { MessageKey } from './dictionaries';

export const inputWordingEn = {
  // ----- the Run screen -----
  'conv.lead': 'Drop a file. We find which of your formats it is for and make it into that format.',
  'conv.lead.many': 'Drop a file, or up to {n} at once. We find which of your formats each one is for and make it into that format.',
  'conv.onlyFormat': 'Only the input files of {format}.',
  'conv.noSources.textFormat': 'This format has no input files yet.',
  'conv.matching': 'Finding the format…',
  'conv.choose.title': 'Which kind of input file is this?',
  'conv.choose.lead': "We are not sure enough to pick for you, so we didn't guess. Choose the kind of input file this is.",
  'conv.choose.pick': 'Use this one',
  'conv.match.auto': 'Matched to {format} (input file: {source}).',
  'conv.match.source': 'Matched to the input file {source}.',
  'conv.noMatch.title': "This file doesn't look like any of your input files",
  'conv.noMatch.text': 'None of your formats takes an input file with enough of these columns.',
  'conv.noMatch.todo': 'Check that it is the right file. If it is a new layout, teach it on Home with the output you want from it.',
  'conv.missing.text.one': 'The input file {source} needs a column this file does not have:',
  'conv.missing.text.other': 'The input file {source} needs {count} columns this file does not have:',
  'conv.missing.todo': 'Add the column to the file with exactly this name and drop the file again. If it is the wrong kind of file, choose another one.',
  'conv.map.lead.one': "The input file {source} needs a column that this file doesn't have under that name. Say which column of the file it is.",
  'conv.map.lead.other': "The input file {source} needs {count} columns that this file doesn't have under those names. Say which column of the file each one is.",
  'conv.map.remember.hint.all': 'It is saved with this kind of input file, so next time it applies to all {n} of its formats with no questions.',
  'conv.formats.lead': 'This file is the input file {source}. Choose the formats this file should be made into. Each one is checked on its own, and you look at its flagged rows before its file is made.',
  'conv.attention.lead': 'This file is the input file {source}. Some of its formats can be made from this file and some need a look. Nothing is changed for you: choose what to do about each one.',
  'conv.attention.lead.none': 'This file is the input file {source}. None of its formats can be made from this file as it is. Nothing is changed for you: choose what to do about each one.',
  'conv.newColumns.hint': "Once dismissed, we won't mention this for this kind of input file again.",
  'conv.review.rule.hint': 'Change the rule opens the rules for this input file. When you come back, the file is converted again.',
  'conv.done.source': 'Converted with {format} (input file: {source}).',
  'conv.results.source': 'Converted from the input file {source}: one file for each format.',
  'conv.error.sheetNotFound': "These rules read a sheet that isn't in this file. Choose the right file, or check the sheet in the rules.",
  'conv.error.invalidRules': "These rules can't run. Open the format in My formats and fix what it says.",
  'conv.error.gone': "That input file isn't in your account any more.",
  'batch.drop.caption': 'Up to {n} files, for any of your formats',
  'batch.reason.noSource': "It doesn't look like any of your input files.",
  'batch.reason.unsure': 'More than one kind of input file fits, so it was not converted on a guess.',
  'batch.reason.rules': "The rules for {source} can't run on it.",
  'batch.reason.gone': "That input file isn't in your account any more.",
  'batch.summary.col.source': 'Input file',
  // ----- My formats, a format's page -----
  'formats.lead': 'Your saved formats, ready to run.',
  'formats.deleteText.one': 'This deletes the format and its rules. It frees a saved-format slot, but it does not give back any AI formats you used.',
  'formats.deleteText.other': 'This deletes the format and the rules of its {n} input files. It frees a saved-format slot, but it does not give back any AI formats you used.',
  'format.sources': 'Input files',
  'format.noSources': 'This format has no input files yet.',
  'format.source.rename': 'Rename',
  'format.source.renameLabel': 'Name',
  'format.source.delete': 'Remove this input file',
  'format.source.deleteTitle': 'Remove the input file "{name}"?',
  'format.source.deleteText': 'The format and its other input files stay.',
  'format.source.deleteConfirm': 'Remove this input file',
  // ----- the editor of saved rules -----
  'edit.note': 'An input file of "{format}". We do not keep your files.',
  'edit.conflict': 'These rules were changed somewhere else in the meantime. Reload them and try again.',
  'edit.formatChange.warn.one': 'This changes the format.',
  'edit.formatChange.warn.other': 'This changes the format for all {n} of its input files.',
  'edit.formatChange.done.none': 'The format changed. It has no other input files.',
  'edit.formatChange.done.one': 'The format changed, and the change reached 1 other input file.',
  'edit.formatChange.done.other': 'The format changed, and the change reached {n} other input files.',
  'edit.needsReview.one': '1 input file needs review',
  'edit.needsReview.other': '{n} input files need review',
  'edit.needsReview.sourceText': 'Their rules no longer line up with the changed input file. Open each one and check its rules:',
  'edit.sourceChange.warn': 'This changes how this input file is read, for {n} formats.',
  'edit.sourceChange.done.none': 'The input file changed. No other format reads it.',
  'edit.sourceChange.done.one': 'The input file changed, and the change reached 1 other format that reads it.',
  'edit.sourceChange.done.other': 'The input file changed, and the change reached {n} other formats that read it.',
  'static.formatLock': '{where} no longer matches the format these rules belong to: {detail}.',
  'static.sourceLock': "{where} doesn't match the input file you chose: {detail}.",
  'editor.formatChange.one': 'This changes the format.',
  'editor.formatChange.other': 'This changes the format for all {n} of its input files.',
  'editor.readAs.note': 'This is part of how the input file is read, so every format that reads it gets this rule.',
  // ----- the result screen -----
  'partial.line.reason.external': "We couldn't find this column's values in your input file, so it may come from somewhere else. The AI step will try it; you can also fill it in yourself.",
  'deep.external': 'may come from somewhere else',
  // ----- the public pages -----
  'business.lead':
    'Files arrive from suppliers, insurers, clients and other systems, each in its own layout. Teach each format once, add each new kind of input file in minutes, and every file is checked.',
  'business.idea.text':
    'Show formatAI one example: a file as it arrives, and the result you want from it. It writes the rules in plain words, and you check them. Teach each format once, add each new kind of input file in minutes, and from then on every file is converted the same way and checked.',
  'plan.row.sources': 'Input files per format',
} as const satisfies Partial<Record<MessageKey, string>>;

export type InputWordingKey = keyof typeof inputWordingEn;

export const inputWordingHe: Record<InputWordingKey, string> = {
  'conv.lead': 'גררו קובץ. אנחנו מזהים לאיזה מהפורמטים שלכם הוא שייך ומכינים אותו בפורמט הזה.',
  'conv.lead.many': 'גררו קובץ, או עד {n} קבצים בבת אחת. אנחנו מזהים לאיזה מהפורמטים שלכם כל אחד מהם שייך ומכינים אותו בפורמט הזה.',
  'conv.onlyFormat': 'רק קובצי הקלט של {format}.',
  'conv.noSources.textFormat': 'לפורמט הזה עדיין אין קובצי קלט.',
  'conv.matching': 'מזהים את הפורמט…',
  'conv.choose.title': 'איזה סוג של קובץ קלט זה?',
  'conv.choose.lead': 'אנחנו לא בטוחים מספיק כדי לבחור בשבילכם, ולכן לא ניחשנו. בחרו איזה סוג של קובץ קלט זה.',
  'conv.choose.pick': 'להשתמש בזה',
  'conv.match.auto': 'הקובץ הותאם ל{format} (קובץ קלט: {source}).',
  'conv.match.source': 'הקובץ הותאם לקובץ הקלט {source}.',
  'conv.noMatch.title': 'הקובץ הזה לא נראה כמו אף אחד מקובצי הקלט שלכם',
  'conv.noMatch.text': 'אף אחד מהפורמטים שלכם לא מקבל קובץ קלט עם מספיק מהעמודות האלה.',
  'conv.noMatch.todo': 'בדקו שזה הקובץ הנכון. אם זו תבנית חדשה, למדו אותה בדף הבית עם הפלט שאתם רוצים ממנה.',
  'conv.missing.text.one': 'לקובץ הקלט {source} דרושה עמודה שאין בקובץ הזה:',
  'conv.missing.text.other': 'לקובץ הקלט {source} דרושות {count} עמודות שאין בקובץ הזה:',
  'conv.missing.todo': 'הוסיפו את העמודה לקובץ בדיוק בשם הזה וגררו את הקובץ שוב. אם זה סוג הקובץ הלא נכון, בחרו אחר.',
  'conv.map.lead.one': 'לקובץ הקלט {source} דרושה עמודה שאין בקובץ הזה בשם הזה. אמרו איזו עמודה בקובץ היא.',
  'conv.map.lead.other': 'לקובץ הקלט {source} דרושות {count} עמודות שאין בקובץ הזה בשמות האלה. אמרו איזו עמודה בקובץ היא כל אחת מהן.',
  'conv.map.remember.hint.all': 'השם נשמר עם סוג קובץ הקלט הזה, ולכן בפעם הבאה הוא יזוהה בלי לשאול בכל {n} הפורמטים שלו.',
  'conv.formats.lead': 'הקובץ הזה הוא קובץ הקלט {source}. בחרו את הפורמטים שצריך להכין מהקובץ הזה. כל פורמט נבדק בנפרד, ואתם עוברים על השורות המסומנות שלו לפני שהקובץ שלו נוצר.',
  'conv.attention.lead': 'הקובץ הזה הוא קובץ הקלט {source}. אפשר להכין ממנו חלק מהפורמטים, וחלקם דורשים מבט. שום דבר לא משתנה בשבילכם: בחרו מה לעשות עם כל אחד.',
  'conv.attention.lead.none': 'הקובץ הזה הוא קובץ הקלט {source}. אי אפשר להכין ממנו אף אחד מהפורמטים כמו שהוא. שום דבר לא משתנה בשבילכם: בחרו מה לעשות עם כל אחד.',
  'conv.newColumns.hint': 'אחרי הסגירה לא נזכיר את זה שוב עבור סוג קובץ הקלט הזה.',
  'conv.review.rule.hint': 'שינוי הכלל פותח את הכללים של קובץ הקלט הזה. כשתחזרו, הקובץ יומר שוב.',
  'conv.done.source': 'הומר באמצעות {format} (קובץ קלט: {source}).',
  'conv.results.source': 'הומר מקובץ הקלט {source}: קובץ אחד לכל פורמט.',
  'conv.error.sheetNotFound': 'הכללים האלה קוראים גיליון שלא קיים בקובץ הזה. בחרו את הקובץ הנכון, או בדקו את הגיליון בכללים.',
  'conv.error.invalidRules': 'הכללים האלה לא יכולים לרוץ. פתחו את הפורמט ב"הפורמטים שלי" ותקנו את מה שכתוב שם.',
  'conv.error.gone': 'קובץ הקלט הזה כבר לא נמצא בחשבון שלכם.',
  'batch.drop.caption': 'עד {n} קבצים, לכל אחד מהפורמטים שלכם',
  'batch.reason.noSource': 'הוא לא נראה כמו אף אחד מקובצי הקלט שלכם.',
  'batch.reason.unsure': 'יותר מסוג אחד של קובץ קלט מתאים, ולכן הקובץ לא הומר על סמך ניחוש.',
  'batch.reason.rules': 'הכללים של {source} לא יכולים לרוץ עליו.',
  'batch.reason.gone': 'קובץ הקלט הזה כבר לא נמצא בחשבון שלכם.',
  'batch.summary.col.source': 'קובץ קלט',
  'formats.lead': 'הפורמטים ששמרתם, מוכנים להרצה.',
  'formats.deleteText.one': 'זה מוחק את הפורמט ואת הכללים שלו. זה פותח מקום לפורמט שמור נוסף, אבל לא מחזיר פורמטים עם AI שכבר ניצלתם.',
  'formats.deleteText.other': 'זה מוחק את הפורמט ואת הכללים של {n} קובצי הקלט שלו. זה פותח מקום לפורמט שמור נוסף, אבל לא מחזיר פורמטים עם AI שכבר ניצלתם.',
  'format.sources': 'קובצי קלט',
  'format.noSources': 'לפורמט הזה עוד אין קובצי קלט.',
  'format.source.rename': 'שינוי שם',
  'format.source.renameLabel': 'שם',
  'format.source.delete': 'הסרת קובץ הקלט הזה',
  'format.source.deleteTitle': 'להסיר את קובץ הקלט "{name}"?',
  'format.source.deleteText': 'הפורמט וקובצי הקלט האחרים שלו נשארים.',
  'format.source.deleteConfirm': 'הסרת קובץ הקלט הזה',
  'edit.note': 'קובץ קלט של "{format}". אנחנו לא שומרים את הקבצים שלכם.',
  'edit.conflict': 'הכללים האלה שונו בינתיים במקום אחר. טענו אותם מחדש ונסו שוב.',
  'edit.formatChange.warn.one': 'השינוי הזה משנה את הפורמט.',
  'edit.formatChange.warn.other': 'השינוי הזה משנה את הפורמט בכל {n} קובצי הקלט שלו.',
  'edit.formatChange.done.none': 'הפורמט השתנה. אין לו קובצי קלט אחרים.',
  'edit.formatChange.done.one': 'הפורמט השתנה, והשינוי הגיע לקובץ קלט אחד נוסף.',
  'edit.formatChange.done.other': 'הפורמט השתנה, והשינוי הגיע ל-{n} קובצי קלט נוספים.',
  'edit.needsReview.one': 'קובץ קלט אחד דורש בדיקה',
  'edit.needsReview.other': '{n} קובצי קלט דורשים בדיקה',
  'edit.needsReview.sourceText': 'הכללים שלהם כבר לא מתאימים לקובץ הקלט ששונה. פתחו כל אחד ובדקו את הכללים שלו:',
  'edit.sourceChange.warn': 'השינוי הזה משנה את האופן שבו קובץ הקלט הזה נקרא, עבור {n} פורמטים.',
  'edit.sourceChange.done.none': 'קובץ הקלט השתנה. אף פורמט אחר לא קורא אותו.',
  'edit.sourceChange.done.one': 'קובץ הקלט השתנה, והשינוי הגיע לפורמט אחד נוסף שקורא אותו.',
  'edit.sourceChange.done.other': 'קובץ הקלט השתנה, והשינוי הגיע ל-{n} פורמטים נוספים שקוראים אותו.',
  'static.formatLock': '{where}: כבר לא תואם לפורמט שהכללים האלה שייכים אליו ({detail}).',
  'static.sourceLock': '{where}: לא תואם לקובץ הקלט שבחרתם ({detail}).',
  'editor.formatChange.one': 'השינוי הזה משנה את הפורמט.',
  'editor.formatChange.other': 'השינוי הזה משנה את הפורמט בכל {n} קובצי הקלט שלו.',
  'editor.readAs.note': 'זה חלק מהאופן שבו קובץ הקלט נקרא, ולכן כל פורמט שקורא אותו מקבל את הכלל הזה.',
  'partial.line.reason.external': 'לא מצאנו את הערכים של העמודה הזו בקובץ הקלט שלכם, ולכן היא אולי מגיעה ממקום אחר. שלב ה-AI ינסה אותה; אפשר גם למלא אותה בעצמכם.',
  'deep.external': 'אולי מגיע ממקום אחר',
  'business.lead':
    'קבצים מגיעים מספקים, מחברות ביטוח, מלקוחות וממערכות אחרות, כל אחד בפריסה משלו. מלמדים כל פורמט פעם אחת, מוסיפים כל סוג חדש של קובץ קלט בתוך דקות, וכל קובץ נבדק.',
  'business.idea.text':
    'מראים ל-formatAI דוגמה אחת: קובץ כפי שהוא מגיע, ואת התוצאה שרוצים ממנו. הוא כותב את הכללים במילים פשוטות, ואתם בודקים אותם. מלמדים כל פורמט פעם אחת, מוסיפים כל סוג חדש של קובץ קלט בתוך דקות, ומאותו רגע כל קובץ מומר באותה צורה ונבדק.',
  'plan.row.sources': 'קובצי קלט לכל פורמט',
};

/** The shared codes' texts that say "source", in the input wording (`code()` reads them while the switch is off). */
export const inputCodeWording: {
  apiError: Partial<Record<ApiErrorCode, { en: string; he: string }>>;
  limit: Partial<Record<LimitCode, { en: string; he: string }>>;
  preflight: Partial<Record<PreflightWarnReason, { en: string; he: string }>>;
} = {
  apiError: {
    nameTaken: { en: 'You already have an input file with that name. Choose a different name.', he: 'כבר יש לכם קובץ קלט בשם הזה. בחרו שם אחר.' },
    sourceMismatch: {
      en: "This file's columns don't match the input file it belongs to. See which columns differ and fix them, or save it as a new format.",
      he: 'העמודות של הקובץ הזה לא תואמות לקובץ הקלט שאליו הוא שייך. ראו אילו עמודות שונות ותקנו אותן, או שמרו אותו כפורמט חדש.',
    },
    sourceInUse: { en: 'This input file is still used by a format. Remove it from its formats first.', he: 'קובץ הקלט הזה עדיין משמש פורמט. הסירו אותו מהפורמטים שלו קודם.' },
    aliasConflict: { en: 'That column name is already used for a different column of this input file.', he: 'שם העמודה הזה כבר משמש עמודה אחרת של קובץ הקלט הזה.' },
  },
  limit: {
    sourcesPerFormat: { en: 'This format already takes as many input files as your plan allows.', he: 'הפורמט הזה כבר מקבל את מספר קובצי הקלט המרבי שהתוכנית שלכם מאפשרת.' },
  },
  preflight: {
    unknownOutputColumns: {
      en: "We couldn't find these columns' values in your input file. The AI step will try them; if they come from somewhere else they'll stay empty.",
      he: 'לא מצאנו את הערכים של העמודות האלה בקובץ הקלט שלכם. שלב ה-AI ינסה אותן; אם הן מגיעות ממקום אחר, הן יישארו ריקות.',
    },
  },
};

/**
 * The messages that say "source" and are shown only by the explicit source UI the switch hides (Add a source, the source count and names on
 * My formats' cards, the source limit there): they keep their wording, and never show while the switch is off.
 */
export const SOURCE_UI_ONLY: readonly MessageKey[] = [
  'formats.sources.none',
  'formats.sources.one',
  'formats.sources.other',
  'formats.addSource',
  'formats.sourceLimit',
  'add.title',
  'add.sourceName',
  'add.sourceNameHint',
  'add.learn',
  'add.saveMismatch.title',
  'add.saveSourceMismatch.title',
  'add.save',
  'add.saved',
  'add.deep.whole',
];
