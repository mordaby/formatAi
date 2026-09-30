// UI strings of the account and sign-in side (SPEC 12, 5 E, 21 v5): the account menu, the sign-in wall, the return from
// the provider, the local (partial) result and its "sign in to finish" popup, the AI quota and its limits, saving.
// Merged into `en` and `he` in dictionaries.ts (where a missing Hebrew string is caught by the compiler).
//
// The sentences the shared package already owns (API errors, limits, the AI readiness issues) are not repeated here:
// they come through `useI18n().code(...)` and `aiReadinessMessages`.

export const accountEn = {
  // ----- header and the account menu -----
  'account.menu': 'Account',
  'account.menuLabel': 'Account menu for {name}',
  'account.signedIn': 'Signed in',
  'account.tier.registered': 'Free plan',
  'account.tier.paid': 'Paid plan',
  'account.aiLeft.month': 'AI formats left this month: {n}',
  'account.aiLeft.day': 'AI formats left today: {n}',
  'account.aiLeft.lifetime': 'AI formats left: {n}',
  'account.aiLeft.unlimited': 'AI formats: no limit',
  'account.myFormats': 'My formats',
  'account.linkProvider': 'Link {provider}',
  'account.linkFailed': "We couldn't start linking. Try again in a moment.",
  'account.signOut': 'Sign out',
  'account.signOutFailed': "We couldn't sign you out. Try again.",
  'provider.google': 'Google',
  'provider.microsoft': 'Microsoft',

  // ----- coming back from the provider (?authError= / ?linked=) -----
  'auth.error.expired': 'The sign-in took too long or was already used. Try again.',
  'auth.error.denied': 'You chose not to sign in, so nothing changed.',
  'auth.error.failed': "We couldn't complete the sign-in. Try again in a moment.",
  'auth.error.sessionMismatch': 'You were signed in to a different account when you started linking. Sign in again and try once more.',
  'auth.error.identityInUse': "That account already belongs to another user here, so it can't be linked to yours.",
  'auth.error.providerLinked': 'That provider is already linked to your account.',
  'auth.linked': '{provider} is now linked to your account.',
  'auth.dismiss': 'Dismiss',

  // ----- the sign-in wall -----
  'signIn.ai': 'Sign in free to finish this with the AI step.',
  'signIn.formats': 'Sign in to see your saved formats.',
  'signIn.noProviders': "Signing in isn't set up on this server yet. You can keep using the tool without an account.",
  'signIn.loading': 'Checking how you can sign in…',
  'signIn.going': 'Taking you to {provider}…',
  'signIn.keptLocal': 'It is kept in this browser only, for an hour, and is never sent to us.',
  'signIn.failed': "We couldn't start the sign-in. Try again.",

  // ----- the local result, before the AI step (SPEC 21 v5 item 1) -----
  'partial.popup.title': 'Sign in to finish',
  'partial.popup.one':
    'We worked out {solved} of {total} columns on your computer. 1 needs the AI step — sign in free to finish ({included}).',
  'partial.popup.other':
    'We worked out {solved} of {total} columns on your computer. {needsAi} need the AI step — sign in free to finish ({included}).',
  'partial.popup.parts':
    'We worked out {solved} of {total} columns on your computer. The rest of the format (how the rows are shaped and laid out) needs the AI step — sign in free to finish ({included}).',
  'partial.popup.external.one': ' 1 more column has values that are not in your input file, so it needs your input.',
  'partial.popup.external.other': ' {n} more columns have values that are not in your input file, so they need your input.',
  'partial.popup.later': 'Not now',
  'partial.included.month': '{n} AI formats a month included',
  'partial.included.day': '{n} AI formats a day included',
  'partial.included.lifetime': '{n} AI formats included',
  'partial.included.unlimited': 'AI formats included',
  'partial.section': 'Needs the AI step',
  'partial.section.lead': 'Your computer could not work these out on its own.',
  'partial.line.reason': 'The AI step works out how this column is made. You can also fill it in yourself.',
  'partial.badge.one': '1 column needs the AI step',
  'partial.badge.other': '{n} columns need the AI step',
  'partial.badge.parts': 'The layout needs the AI step',
  'partial.banner.anon':
    '{solved} of {total} columns are worked out and match your example. The rest needs the AI step, which is free when you sign in.',
  'partial.banner.signedIn': 'The AI step can work out the rest. It only uses up one of your AI formats if it succeeds.',
  'partial.banner.signIn': 'Sign in free to finish',
  'partial.finish': 'Finish with the AI step',
  'partial.finishNote': 'What needs the AI step is marked below.',
  'partial.note': 'Worked out on your computer; the rest needs the AI step',
  'partial.saveHint': 'This is only what your computer worked out so far, so it cannot be saved yet.',
  'partial.onlyExternal.title': 'Some columns need your input',
  'partial.onlyExternal.todo': 'Fill them in on the map below, or save the format and leave them empty.',

  // ----- the AI step could not run (SPEC 21 v5 item 4) -----
  'notReady.title': "The AI step can't help with these files",
  'notReady.nothingUsed': 'Nothing was used up.',

  // ----- the AI quota and its limits (SPEC 11, 21 v5 items 2-3) -----
  'aiLimit.title': "You've used your AI formats",
  'aiLimit.local': 'Formats your computer can work out on its own, and every format you saved, keep working.',
  'aiLimit.upgrade': 'Upgrade',
  'upgrade.title': 'Upgrade your plan',
  'upgrade.text': 'Paid plans are set up by our team for now. Write to us and we will raise your limits.',
  'upgrade.contact': 'Contact us',
  'aiExhausted.title': 'We stopped after {n} tries',
  'aiExhausted.todo': 'Change something in the example files, then start again.',
  'aiLeft.note': 'AI formats left: {n}',
  'ai.attempt': "The AI step got this far, but not every row matches your example (try {n} of {max}). Fix the rest in the map, or start again with corrected files.",

  // ----- saving (SPEC 5 A step 8, 8.11 "Saving") -----
  'save.differences.one': 'Save with 1 difference and download',
  'save.differences.other': 'Save with {n} differences and download',
  'save.saving': 'Saving…',
  'save.done': 'Saved. "{name}" is in My formats, and your file is downloading.',
  'save.viewFormats': 'Open My formats',
  'save.failed': "We couldn't save the format. Try again in a moment.",
  'save.downloadFailed': "The format was saved, but we couldn't prepare the file. Open it from My formats and convert the file there.",
  'save.problems': 'What stopped the save:',
  'save.signInToSave': 'Sign in to save',

  // ----- flow A: "this looks like your format X" (SPEC 5 A2) -----
  'match.title': 'This looks like your format "{name}"',
  'match.text': 'Add this file as a new source for it?',
  'match.add': 'Add as a new source',
  'match.dismiss': 'No, save it as a new format',
} as const satisfies Record<string, string>;

export const accountHe: Record<keyof typeof accountEn, string> = {
  'account.menu': 'חשבון',
  'account.menuLabel': 'תפריט החשבון של {name}',
  'account.signedIn': 'מחוברים',
  'account.tier.registered': 'תוכנית חינמית',
  'account.tier.paid': 'תוכנית בתשלום',
  'account.aiLeft.month': 'פורמטים עם AI שנותרו החודש: {n}',
  'account.aiLeft.day': 'פורמטים עם AI שנותרו היום: {n}',
  'account.aiLeft.lifetime': 'פורמטים עם AI שנותרו: {n}',
  'account.aiLeft.unlimited': 'פורמטים עם AI: ללא הגבלה',
  'account.myFormats': 'הפורמטים שלי',
  'account.linkProvider': 'קישור {provider}',
  'account.linkFailed': 'לא הצלחנו להתחיל את הקישור. נסו שוב בעוד רגע.',
  'account.signOut': 'התנתקות',
  'account.signOutFailed': 'לא הצלחנו להתנתק. נסו שוב.',
  'provider.google': 'Google',
  'provider.microsoft': 'Microsoft',

  'auth.error.expired': 'ההתחברות ארכה יותר מדי או שכבר נוצלה. נסו שוב.',
  'auth.error.denied': 'בחרתם לא להתחבר, ולכן דבר לא השתנה.',
  'auth.error.failed': 'לא הצלחנו להשלים את ההתחברות. נסו שוב בעוד רגע.',
  'auth.error.sessionMismatch': 'כשהתחלתם לקשר, הייתם מחוברים לחשבון אחר. התחברו שוב ונסו פעם נוספת.',
  'auth.error.identityInUse': 'החשבון הזה כבר שייך למשתמש אחר כאן, ולכן אי אפשר לקשר אותו לחשבון שלכם.',
  'auth.error.providerLinked': 'הספק הזה כבר מקושר לחשבון שלכם.',
  'auth.linked': '{provider} מקושר עכשיו לחשבון שלכם.',
  'auth.dismiss': 'סגירה',

  'signIn.ai': 'התחברו בחינם כדי להשלים את זה בעזרת שלב ה-AI.',
  'signIn.formats': 'התחברו כדי לראות את הפורמטים ששמרתם.',
  'signIn.noProviders': 'ההתחברות עדיין לא הוגדרה בשרת הזה. אפשר להמשיך להשתמש בכלי גם בלי חשבון.',
  'signIn.loading': 'בודקים איך אפשר להתחבר…',
  'signIn.going': 'מעבירים אתכם אל {provider}…',
  'signIn.keptLocal': 'זה נשמר בדפדפן הזה בלבד, לשעה אחת, ולא נשלח אלינו.',
  'signIn.failed': 'לא הצלחנו להתחיל את ההתחברות. נסו שוב.',

  'partial.popup.title': 'התחברו כדי להשלים',
  'partial.popup.one':
    'הבנו {solved} מתוך {total} עמודות במחשב שלכם. עמודה אחת דורשת את שלב ה-AI — התחברו בחינם כדי להשלים ({included}).',
  'partial.popup.other':
    'הבנו {solved} מתוך {total} עמודות במחשב שלכם. {needsAi} דורשות את שלב ה-AI — התחברו בחינם כדי להשלים ({included}).',
  'partial.popup.parts':
    'הבנו {solved} מתוך {total} עמודות במחשב שלכם. שאר הפורמט (איך השורות מסודרות ומעוצבות) דורש את שלב ה-AI — התחברו בחינם כדי להשלים ({included}).',
  'partial.popup.external.one': ' עוד עמודה אחת עם ערכים שלא מופיעים בקובץ הקלט, ולכן היא דורשת את ההזנה שלכם.',
  'partial.popup.external.other': ' עוד {n} עמודות עם ערכים שלא מופיעים בקובץ הקלט, ולכן הן דורשות את ההזנה שלכם.',
  'partial.popup.later': 'לא עכשיו',
  'partial.included.month': 'כולל {n} פורמטים עם AI בחודש',
  'partial.included.day': 'כולל {n} פורמטים עם AI ביום',
  'partial.included.lifetime': 'כולל {n} פורמטים עם AI',
  'partial.included.unlimited': 'כולל פורמטים עם AI',
  'partial.section': 'דורש את שלב ה-AI',
  'partial.section.lead': 'המחשב שלכם לא הצליח להבין את אלה בכוחות עצמו.',
  'partial.line.reason': 'שלב ה-AI מבין איך העמודה הזו נוצרת. אפשר גם למלא אותה בעצמכם.',
  'partial.badge.one': 'עמודה אחת דורשת את שלב ה-AI',
  'partial.badge.other': '{n} עמודות דורשות את שלב ה-AI',
  'partial.badge.parts': 'הפריסה דורשת את שלב ה-AI',
  'partial.banner.anon': '{solved} מתוך {total} עמודות הובנו ותואמות לדוגמה שלכם. השאר דורש את שלב ה-AI, שהוא חינם כשמתחברים.',
  'partial.banner.signedIn': 'שלב ה-AI יכול להבין את השאר. הוא מנצל אחד מהפורמטים עם AI שלכם רק אם הוא מצליח.',
  'partial.banner.signIn': 'התחברו בחינם כדי להשלים',
  'partial.finish': 'השלמה עם שלב ה-AI',
  'partial.finishNote': 'מה שדורש את שלב ה-AI מסומן למטה.',
  'partial.note': 'הובן במחשב שלכם; השאר דורש את שלב ה-AI',
  'partial.saveHint': 'זה רק מה שהמחשב שלכם הבין עד עכשיו, ולכן אי אפשר לשמור אותו עדיין.',
  'partial.onlyExternal.title': 'חלק מהעמודות דורשות את ההזנה שלכם',
  'partial.onlyExternal.todo': 'מלאו אותן במפה שלמטה, או שמרו את הפורמט והשאירו אותן ריקות.',

  'notReady.title': 'שלב ה-AI לא יכול לעזור עם הקבצים האלה',
  'notReady.nothingUsed': 'לא נוצל דבר.',

  'aiLimit.title': 'ניצלתם את הפורמטים עם AI',
  'aiLimit.local': 'פורמטים שהמחשב שלכם מבין בכוחות עצמו, וכל פורמט ששמרתם, ממשיכים לעבוד.',
  'aiLimit.upgrade': 'שדרוג',
  'upgrade.title': 'שדרוג התוכנית',
  'upgrade.text': 'תוכניות בתשלום מוגדרות כרגע על ידי הצוות שלנו. כתבו לנו ונרחיב את המגבלות שלכם.',
  'upgrade.contact': 'יצירת קשר',
  'aiExhausted.title': 'עצרנו אחרי {n} ניסיונות',
  'aiExhausted.todo': 'שנו משהו בקבצי הדוגמה והתחילו מחדש.',
  'aiLeft.note': 'פורמטים עם AI שנותרו: {n}',
  'ai.attempt': 'שלב ה-AI התקדם עד כאן, אבל לא כל שורה תואמת לדוגמה שלכם (ניסיון {n} מתוך {max}). תקנו את השאר במפה, או התחילו מחדש עם קבצים מתוקנים.',

  'save.differences.one': 'שמירה עם הבדל אחד והורדה',
  'save.differences.other': 'שמירה עם {n} הבדלים והורדה',
  'save.saving': 'שומרים…',
  'save.done': 'נשמר. "{name}" נמצא עכשיו ברשימת הפורמטים שלכם, והקובץ שלכם יורד.',
  'save.viewFormats': 'פתיחת הפורמטים שלי',
  'save.failed': 'לא הצלחנו לשמור את הפורמט. נסו שוב בעוד רגע.',
  'save.downloadFailed': 'הפורמט נשמר, אבל לא הצלחנו להכין את הקובץ. פתחו אותו מהפורמטים שלי והמירו את הקובץ שם.',
  'save.problems': 'מה עצר את השמירה:',
  'save.signInToSave': 'התחברו כדי לשמור',

  'match.title': 'זה נראה כמו הפורמט שלכם "{name}"',
  'match.text': 'להוסיף את הקובץ הזה כמקור חדש שלו?',
  'match.add': 'הוספה כמקור חדש',
  'match.dismiss': 'לא, לשמור כפורמט חדש',
};
