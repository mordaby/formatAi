// The public legal pages (SPEC 15 "Legal pages", 16.1 screen 8; v13 M4): the privacy policy, the terms of use and the accessibility statement,
// in Hebrew and English. Structured text rather than one dictionary key per sentence: `LegalDoc` is a title, an intro and sections of
// paragraphs / bullet lists; `legalDocs` is typed `Record<LegalPageId, Record<Lang, LegalDoc>>`, so the compiler refuses a missing language
// and a test refuses two languages with a different shape.
//
// !!! LEGAL REVIEW NEEDED !!!  The text below is a DRAFT written from what the product really does (SPEC 7, 13, 15, `limits`); it is NOT legal advice
// and has not been read by a lawyer. Before launch the OWNER (or a lawyer) must review and complete:
//   - who "we" are (`webConfig.legal.operator`), the contact address, the court / jurisdiction (`webConfig.legal.jurisdiction`), the hosting
//     and database providers (`webConfig.legal.hosting`), and the accessibility coordinator's details (`webConfig.legal.accessibility`) -
//     each is a visible [placeholder] until filled in;
//   - the retention periods (`webConfig.legal.retentionMonths`): they are PROPOSALS, and no job deletes old `llm_calls`, `leads` or `feedback`
//     documents yet - build the deletion or change the numbers;
//   - what Israeli privacy law requires of a service like this (database registration, an information-security duty, the handling of
//     requests, whether the cookie notice SPEC 15 asks for is needed beyond this page - the cookies used are strictly necessary ones only,
//     so this build has NO cookie banner: DECISION for the owner / the lawyer);
//   - the providers' data terms (checked against Anthropic's and OpenAI's own pages on 2026-10-05: ~30 days of retention, no training on API
//     data by default - they change, re-check before launch), and the claim that Turnstile is the only third-party widget;
//   - the accessibility statement's claims: it says only what was done and tested (own review, keyboard, automated checks); no external audit
//     and no screen-reader pass has been made. Say more only when it is true.
//
// Tokens in a string: `{name}` is filled from `LegalParams` (config and limits - never typed twice); `[text](/path)` is an internal link; a bare
// email address becomes a mailto link.
import type { Lang } from './core';

export type LegalPageId = 'privacy' | 'terms' | 'accessibility';

export type LegalBlock =
  /** A paragraph. */
  | { p: string }
  /** A bullet list. */
  | { ul: readonly string[] }
  /** The one sentence a page stands on, set apart (the privacy promise). */
  | { promise: string };

export interface LegalSection {
  /** The anchor of the section in the page's contents. */
  id: string;
  title: string;
  blocks: readonly LegalBlock[];
}

export interface LegalDoc {
  title: string;
  intro: string;
  sections: readonly LegalSection[];
}

const privacyEn: LegalDoc = {
  title: 'Privacy policy',
  intro: 'This policy explains what formatAI collects, why, who it is shared with and what you can choose. It is written in plain words. {operator} ("we") runs formatAI.',
  sections: [
    {
      id: 'summary',
      title: 'The short version',
      blocks: [
        {
          promise:
            'Your full files never leave your computer. Saved formats contain the column names and the rules you approved, including any fixed values those rules use (such as a label, or the value a code is turned into). Never rows from your files.',
        },
        { p: 'Learning from your two example files, checking the result and converting files all happen in your browser. Nothing on this service uploads a file.' },
        { p: 'AI learning is optional. It happens only when you press a button that says it uses AI, and only when you are signed in.' },
      ],
    },
    {
      id: 'local',
      title: 'What stays on your computer',
      blocks: [
        {
          p: "formatAI reads your files in your browser. Reading the file, the profile of each column, the learning that needs no AI, the check against your example and every conversion run on your computer. Our server has no endpoint that accepts a file.",
        },
        {
          p: "The rules on your screen, your edits and the example files stay in your browser's memory. If you sign in in the middle of learning, the rules and the example are kept in your browser's own storage for up to an hour, so nothing has to be done again, and are then deleted. Nothing of this is sent to us.",
        },
      ],
    },
    {
      id: 'ai',
      title: 'What is sent when you use AI learning',
      blocks: [
        {
          p: 'AI learning (the buttons "Learn with AI" and "Finish with AI") is opt-in and needs a sign-in. When you use it, your browser sends our server a small summary of your example files, and our server passes it to an AI provider, which writes the rules. The summary is:',
        },
        {
          ul: [
            'the column names, and a profile of each column: its type, its shape, how many cells are empty, and its smallest and largest value;',
            'a sample of rows: up to {pairs} pairs of an input row and the output row made from it, and up to {dropped} rows the example left out. If the first answer does not match every row of your example, up to {rounds} more requests carry some of the rows it got wrong. In one learn, at most {rows} rows leave your computer in all;',
            'what your computer has already worked out, for example which columns are copied or calculated.',
          ],
        },
        {
          p: 'Masking is on by default. With masking on, names, ID numbers and other text in the sample rows are replaced with look-alike values of the same shape before anything leaves your computer. Numbers, dates, column names and "no value" placeholders (such as N/A or a dash) are sent as they are, because the rules cannot be learned without them. The key that maps the look-alike values back stays in your browser. If you turn masking off, the sample rows are sent as they are.',
        },
        { p: 'The "See what we send" panel on the home page shows the exact data, before and after it is sent.' },
        { p: 'Our server passes the request to the AI provider and returns the answer. It does not keep the sample rows. Who the providers are and what they do with the data is under "Service providers".' },
      ],
    },
    {
      id: 'stored',
      title: 'What we store',
      blocks: [
        {
          ul: [
            "Your account: the name, email address and picture your Google or Microsoft account gives us, that provider's identifier for you, your language and your plan.",
            'Your saved formats and sources: column names, the rules you approved (including any fixed values they use, such as labels and lookup entries), your edits and earlier versions. Never rows from your files.',
            'Usage counts, for example how many AI formats you used this month and how many formats you saved.',
            'AI call records: when a call was made, which model, how many tokens it used, what it cost and whether it worked. Counts only, never the content of a request or an answer.',
            'A short-lived copy of the rules the AI wrote for a given structure of files, for you only, for up to {cacheDays} days, so the same structure is not learned twice. Only when masking was on and the rules hold no text values; with masking off nothing is kept.',
            'What you send us in a form on this site (the business contact form, the paid waitlist, feedback): your name, email, company and message as you typed them, and the path of the page you were on, for example /formats. A form never carries file contents or rules.',
            'Abuse protection: counters kept under a scrambled (hashed) version of your IP address, which cannot be turned back into the address, for about two days. We do not store your IP address in a form or in your account.',
          ],
        },
        { p: 'We do not store your files, the rows in them, file names or cell values. Our logs do not contain them either.' },
      ],
    },
    {
      id: 'cookies',
      title: 'Cookies and local storage',
      blocks: [
        { p: 'We use only what the service needs in order to work. There are no advertising or tracking cookies.' },
        {
          ul: [
            'Session cookie (when you sign in): keeps you signed in. It is hidden from page scripts and lasts up to {sessionDays} days after your last visit.',
            'Anonymous id cookie: a random code, set on your first visit, so that usage limits can apply to a visitor who is not signed in. It lasts up to {cookieDays} days. When you sign in it is linked to your account.',
            'Language cookie: remembers whether you chose Hebrew or English.',
            "Accessibility settings: if you change them in the accessibility panel, your choices are kept in this browser's local storage. They are never sent to us.",
          ],
        },
        { p: 'Because these are needed for the service to work, we do not show a cookie banner. You can delete them in your browser settings; you will then be signed out and your choices reset.' },
      ],
    },
    {
      id: 'turnstile',
      title: 'Cloudflare Turnstile',
      blocks: [
        {
          p: 'To tell people from automated programs, the contact, waitlist and feedback forms use Cloudflare Turnstile. It runs a short check in your browser, and Cloudflare receives technical signals such as your IP address and browser details to do it. Cloudflare handles that data under its own privacy policy. Signed-in users are not asked.',
        },
      ],
    },
    {
      id: 'processors',
      title: 'Service providers',
      blocks: [
        { p: 'These providers process data for us, only to provide their service:' },
        {
          ul: [
            'Anthropic and OpenAI write the rules when you use AI learning. They receive only what is described under "What is sent when you use AI learning". Under their current API terms, Anthropic deletes API inputs and outputs within 30 days, OpenAI keeps abuse-monitoring logs for up to 30 days, and neither uses API data to train its models by default. These are their terms and they can change; please read them on their websites.',
            'Google and Microsoft handle sign-in. They tell us your name, email address and picture when you choose to sign in.',
            'Cloudflare runs the Turnstile check described above.',
            'Hosting and database: {hosting}.',
          ],
        },
        { p: 'Some of these providers are outside Israel, for example in the United States and the European Union. We do not sell your data.' },
      ],
    },
    {
      id: 'retention',
      title: 'How long we keep data',
      blocks: [
        {
          ul: [
            'Your account and saved formats: until you ask us to delete them or close your account. You can also delete a saved format yourself on the My formats page at any time.',
            'AI call records: up to {llmMonths} months.',
            'What you sent in a form (contact, waitlist, feedback): up to {formsMonths} months, or until you ask us to delete it.',
            'The rules cache: {cacheDays} days. Limit counters: about two days. Sessions: {sessionDays} days after last use.',
          ],
        },
      ],
    },
    {
      id: 'rights',
      title: 'Your choices and rights',
      blocks: [
        {
          p: 'Under the Israeli Protection of Privacy Law, 5741-1981, you may ask to see the personal information we hold about you, and to correct or delete it. Write to us at {contactEmail}, from the address you used with us, and we will answer. Giving us personal information is your choice, but without it some features (such as saving formats) cannot work.',
        },
        { p: 'If you think we handled your information wrongly, you can also contact the Privacy Protection Authority.' },
      ],
    },
    {
      id: 'security',
      title: 'Security',
      blocks: [
        {
          p: 'Data travels over encrypted connections (HTTPS), sessions use private cookies, and access to our database is limited. No system is perfectly secure and we cannot promise that nothing will ever go wrong. If something happens that affects you, we will tell you as the law requires.',
        },
      ],
    },
    {
      id: 'changes',
      title: 'Changes to this policy',
      blocks: [{ p: 'We may update this policy as the service grows. The date at the top says when it last changed. When a change matters, we will say so on the site.' }],
    },
    {
      id: 'contact',
      title: 'Contact',
      blocks: [{ p: 'Questions or requests: {contactEmail}. {operator}. See also the [terms of use](/terms) and the [accessibility statement](/accessibility).' }],
    },
  ],
};

const privacyHe: LegalDoc = {
  title: 'מדיניות פרטיות',
  intro: 'המדיניות הזו מסבירה מה formatAI אוספת, למה, עם מי היא משותפת ומה אפשר לבחור. היא כתובה במילים פשוטות. {operator} (״אנחנו״) מפעילה את formatAI.',
  sections: [
    {
      id: 'summary',
      title: 'בקצרה',
      blocks: [
        {
          promise:
            'הקבצים המלאים שלכם לעולם לא יוצאים מהמחשב שלכם. פורמטים שמורים כוללים את שמות העמודות ואת הכללים שאישרתם, כולל ערכים קבועים שהכללים האלה משתמשים בהם (כמו תווית, או הערך שקוד הופך אליו). לעולם לא שורות מהקבצים שלכם.',
        },
        { p: 'הלמידה משני קובצי הדוגמה, בדיקת התוצאה והמרת הקבצים מתבצעות כולן בדפדפן שלכם. שום דבר בשירות הזה לא מעלה קובץ.' },
        { p: 'למידה עם AI היא אופציונלית. היא מתרחשת רק כשלוחצים על כפתור שכתוב עליו שהוא משתמש ב-AI, ורק כשמחוברים לחשבון.' },
      ],
    },
    {
      id: 'local',
      title: 'מה נשאר במחשב שלכם',
      blocks: [
        {
          p: 'formatAI קוראת את הקבצים שלכם בדפדפן. קריאת הקובץ, הפרופיל של כל עמודה, הלמידה שלא צריכה AI, הבדיקה מול הדוגמה וכל המרה רצים במחשב שלכם. לשרת שלנו אין נקודת קצה שמקבלת קובץ.',
        },
        {
          p: 'הכללים שעל המסך, העריכות שלכם וקובצי הדוגמה נשארים בזיכרון הדפדפן. אם מתחברים באמצע למידה, הכללים והדוגמה נשמרים באחסון של הדפדפן עצמו עד שעה, כדי שלא יהיה צורך לעשות הכול שוב, ואז נמחקים. שום דבר מזה לא נשלח אלינו.',
        },
      ],
    },
    {
      id: 'ai',
      title: 'מה נשלח כשמשתמשים בלמידה עם AI',
      blocks: [
        {
          p: 'למידה עם AI (הכפתורים ״ללמוד עם AI״ ו״להשלים עם AI״) היא אופציונלית ודורשת התחברות. כשמשתמשים בה, הדפדפן שלכם שולח לשרת שלנו סיכום קטן של קובצי הדוגמה, והשרת מעביר אותו לספק AI שכותב את הכללים. הסיכום הוא:',
        },
        {
          ul: [
            'שמות העמודות ופרופיל של כל עמודה: הסוג, הצורה, כמה תאים ריקים, והערך הקטן והגדול ביותר;',
            'דוגמה של שורות: עד {pairs} זוגות של שורת קלט ושורת הפלט שנוצרה ממנה, ועד {dropped} שורות שהדוגמה השמיטה. אם התשובה הראשונה לא תואמת כל שורה בדוגמה שלכם, עד {rounds} בקשות נוספות נושאות חלק מהשורות שהיא טעתה בהן. בלמידה אחת יוצאות מהמחשב שלכם לכל היותר {rows} שורות בסך הכול;',
            'מה שהמחשב שלכם כבר הבין, למשל אילו עמודות מועתקות או מחושבות.',
          ],
        },
        {
          p: 'הסתרת הנתונים פועלת כברירת מחדל. כשהיא פועלת, שמות, מספרי זהות וטקסט אחר בשורות הדוגמה מוחלפים בערכים מדומים באותה צורה לפני שמשהו יוצא מהמחשב שלכם. מספרים, תאריכים, שמות עמודות ומילים שמסמנות ״אין ערך״ (כמו N/A או מקף) נשלחים כפי שהם, כי אי אפשר ללמוד את הכללים בלעדיהם. המפתח שמחזיר את הערכים המדומים למקור נשאר בדפדפן שלכם. אם מכבים את ההסתרה, שורות הדוגמה נשלחות כפי שהן.',
        },
        { p: 'החלונית ״מה אנחנו שולחים״ בדף הבית מציגה את הנתונים המדויקים, לפני השליחה ואחריה.' },
        { p: 'השרת שלנו מעביר את הבקשה לספק ה-AI ומחזיר את התשובה. הוא לא שומר את שורות הדוגמה. מי הספקים ומה הם עושים עם הנתונים כתוב תחת ״ספקי שירות״.' },
      ],
    },
    {
      id: 'stored',
      title: 'מה אנחנו שומרים',
      blocks: [
        {
          ul: [
            'החשבון שלכם: השם, כתובת האימייל והתמונה שחשבון Google או Microsoft שלכם נותן לנו, המזהה שלכם אצל הספק הזה, השפה והתוכנית שלכם.',
            'הפורמטים והמקורות ששמרתם: שמות עמודות, הכללים שאישרתם (כולל ערכים קבועים שהם משתמשים בהם, כמו תוויות וערכי טבלאות המרה), העריכות שלכם וגרסאות קודמות. לעולם לא שורות מהקבצים שלכם.',
            'ספירות שימוש, למשל כמה פורמטים עם AI השתמשתם החודש וכמה פורמטים שמרתם.',
            'רישומי קריאות AI: מתי בוצעה קריאה, באיזה מודל, כמה אסימונים היא השתמשה, כמה עלתה והאם הצליחה. ספירות בלבד, לעולם לא תוכן של בקשה או של תשובה.',
            'עותק קצר מועד של הכללים שה-AI כתב למבנה קבצים מסוים, רק עבורכם, עד {cacheDays} ימים, כדי שאותו מבנה לא ילמד פעמיים. רק כשהסתרת הנתונים פעלה והכללים לא מכילים ערכי טקסט; כשהיא כבויה לא נשמר דבר.',
            'מה ששלחתם בטופס באתר (טופס יצירת הקשר לעסקים, רשימת ההמתנה לתוכנית בתשלום, משוב): השם, האימייל, החברה וההודעה כפי שהקלדתם, והנתיב של הדף שהייתם בו, למשל /formats. טופס אף פעם לא נושא תוכן של קבצים או כללים.',
            'הגנה מפני שימוש לרעה: מונים ששמורים תחת גרסה מעורבלת (גיבוב) של כתובת ה-IP שלכם, שאי אפשר להחזיר לכתובת, כיומיים. אנחנו לא שומרים את כתובת ה-IP בטופס או בחשבון שלכם.',
          ],
        },
        { p: 'אנחנו לא שומרים את הקבצים שלכם, את השורות שבהם, שמות קבצים או ערכי תאים. גם יומני המערכת שלנו לא כוללים אותם.' },
      ],
    },
    {
      id: 'cookies',
      title: 'עוגיות ואחסון מקומי',
      blocks: [
        { p: 'אנחנו משתמשים רק במה שהשירות צריך כדי לעבוד. אין עוגיות פרסום או מעקב.' },
        {
          ul: [
            'עוגיית התחברות (כשמתחברים): שומרת אתכם מחוברים. היא מוסתרת מסקריפטים בדף ונשארת עד {sessionDays} ימים אחרי הביקור האחרון.',
            'עוגיית מזהה אנונימי: קוד אקראי שנקבע בביקור הראשון, כדי שמגבלות שימוש יחולו על מבקר שלא מחובר. היא נשארת עד {cookieDays} ימים. כשמתחברים היא מקושרת לחשבון.',
            'עוגיית שפה: זוכרת אם בחרתם עברית או אנגלית.',
            'הגדרות נגישות: אם שיניתם אותן בחלונית הנגישות, הבחירות נשמרות באחסון המקומי של הדפדפן הזה. הן לא נשלחות אלינו.',
          ],
        },
        { p: 'מכיוון שאלה נחוצות כדי שהשירות יעבוד, אנחנו לא מציגים באנר עוגיות. אפשר למחוק אותן בהגדרות הדפדפן; אז תתנתקו והבחירות שלכם יתאפסו.' },
      ],
    },
    {
      id: 'turnstile',
      title: 'Cloudflare Turnstile',
      blocks: [
        {
          p: 'כדי להבדיל בין אנשים לתוכנות אוטומטיות, טפסי יצירת הקשר, רשימת ההמתנה והמשוב משתמשים ב-Cloudflare Turnstile. היא מריצה בדיקה קצרה בדפדפן שלכם, ו-Cloudflare מקבלת לשם כך אותות טכניים כמו כתובת ה-IP ופרטי הדפדפן. Cloudflare מטפלת בנתונים האלה לפי מדיניות הפרטיות שלה. משתמשים מחוברים לא נתבקשים לעבור את הבדיקה.',
        },
      ],
    },
    {
      id: 'processors',
      title: 'ספקי שירות',
      blocks: [
        { p: 'הספקים האלה מעבדים מידע עבורנו, רק כדי לספק את השירות שלהם:' },
        {
          ul: [
            'Anthropic ו-OpenAI כותבות את הכללים כשמשתמשים בלמידה עם AI. הן מקבלות רק את מה שמתואר תחת ״מה נשלח כשמשתמשים בלמידה עם AI״. לפי תנאי ה-API הנוכחיים שלהן, Anthropic מוחקת קלטים ופלטים של ה-API תוך 30 יום, OpenAI שומרת יומני איתור שימוש לרעה עד 30 יום, ואף אחת מהן לא משתמשת בנתוני ה-API לאימון המודלים כברירת מחדל. אלה התנאים שלהן והם עשויים להשתנות; מומלץ לקרוא אותם באתרים שלהן.',
            'Google ו-Microsoft מטפלות בהתחברות. הן מוסרות לנו את השם, כתובת האימייל והתמונה שלכם כשבוחרים להתחבר.',
            'Cloudflare מפעילה את בדיקת Turnstile שתוארה למעלה.',
            'אחסון ומסד נתונים: {hosting}.',
          ],
        },
        { p: 'חלק מהספקים האלה נמצאים מחוץ לישראל, למשל בארצות הברית ובאיחוד האירופי. אנחנו לא מוכרים את המידע שלכם.' },
      ],
    },
    {
      id: 'retention',
      title: 'כמה זמן אנחנו שומרים מידע',
      blocks: [
        {
          ul: [
            'החשבון והפורמטים השמורים: עד שתבקשו למחוק אותם או לסגור את החשבון. אפשר גם למחוק פורמט שמור בעצמכם בדף ״הפורמטים שלי״ בכל עת.',
            'רישומי קריאות AI: עד {llmMonths} חודשים.',
            'מה ששלחתם בטופס (יצירת קשר, רשימת המתנה, משוב): עד {formsMonths} חודשים, או עד שתבקשו למחוק.',
            'מטמון הכללים: {cacheDays} ימים. מוני מגבלות: כיומיים. התחברויות: {sessionDays} ימים אחרי השימוש האחרון.',
          ],
        },
      ],
    },
    {
      id: 'rights',
      title: 'הבחירות והזכויות שלכם',
      blocks: [
        {
          p: 'לפי חוק הגנת הפרטיות, התשמ״א-1981, אפשר לבקש לראות את המידע האישי שיש לנו עליכם, ולתקן או למחוק אותו. כתבו אלינו ל-{contactEmail}, מהכתובת שבה השתמשתם אצלנו, ונשיב. מסירת מידע אישי היא בחירה שלכם, אבל בלעדיו חלק מהיכולות (כמו שמירת פורמטים) לא יכולות לעבוד.',
        },
        { p: 'אם לדעתכם טיפלנו במידע שלכם שלא כראוי, אפשר גם לפנות לרשות להגנת הפרטיות.' },
      ],
    },
    {
      id: 'security',
      title: 'אבטחה',
      blocks: [
        {
          p: 'המידע עובר בחיבורים מוצפנים (HTTPS), ההתחברות משתמשת בעוגיות פרטיות, והגישה למסד הנתונים שלנו מוגבלת. אין מערכת מאובטחת לחלוטין ואנחנו לא יכולים להבטיח ששום דבר לא ישתבש. אם יקרה משהו שנוגע אליכם, נודיע לכם כפי שהחוק מחייב.',
        },
      ],
    },
    {
      id: 'changes',
      title: 'שינויים במדיניות',
      blocks: [{ p: 'ייתכן שנעדכן את המדיניות ככל שהשירות יגדל. התאריך בראש הדף אומר מתי היא השתנתה לאחרונה. כששינוי חשוב, נאמר זאת באתר.' }],
    },
    {
      id: 'contact',
      title: 'יצירת קשר',
      blocks: [{ p: 'שאלות או בקשות: {contactEmail}. {operator}. ראו גם את [תנאי השימוש](/terms) ואת [הצהרת הנגישות](/accessibility).' }],
    },
  ],
};

const termsEn: LegalDoc = {
  title: 'Terms of use',
  intro: 'These terms apply when you use formatAI, run by {operator} ("we"). By using the service you agree to them. If you do not agree, please do not use it.',
  sections: [
    {
      id: 'service',
      title: 'The service',
      blocks: [
        {
          p: 'formatAI learns how a file is turned into another from one example, writes the rules in plain words, and applies them to your files in your browser. The service is offered as it is, in an early version. Features, limits and plans can change, and the service may be unavailable at times.',
        },
      ],
    },
    {
      id: 'responsibility',
      title: 'Checking the results is your responsibility',
      blocks: [
        {
          p: 'formatAI checks every value it makes against your example and flags rows that do not fit, but it cannot promise that a result is right. Rules written by AI can be wrong, and a match with your example is a check, not proof. Look at the result before you use it, especially before it goes into another system, a report, a payment or a decision. We are not responsible for what you do with the results.',
        },
        {
          p: 'You are responsible for having the right to use the files you work with, and for following the law that applies to the data in them, including privacy law. Masking reduces what leaves your computer when you use AI learning, but it is not a guarantee that nothing identifying is sent.',
        },
      ],
    },
    {
      id: 'accounts',
      title: 'Your account',
      blocks: [
        {
          p: 'You sign in with a Google or Microsoft account. Keep your sign-in secure and tell us if you think someone else has used your account. Plans and limits are listed on the [business page](/business) and can change; some limits (such as the number of AI formats) apply to your account.',
        },
      ],
    },
    {
      id: 'use',
      title: 'Acceptable use',
      blocks: [
        { p: 'Please do not:' },
        {
          ul: [
            'use the service for anything unlawful, or to process files you have no right to use;',
            'try to break, overload, probe or reverse-engineer the service, or to get around its limits, its anti-bot check or its protections;',
            'use scripts or bots to send requests, or to send a form that was not filled in by a person;',
            "use the AI step to send content that is unlawful or harmful, or to try to make the AI providers' systems misbehave;",
            'share your account, or resell the service, without our written permission.',
          ],
        },
      ],
    },
    {
      id: 'ai',
      title: 'AI learning and privacy',
      blocks: [
        {
          p: 'AI learning is optional. What it sends and to whom is described in the [privacy policy](/privacy). By pressing a button that uses AI you ask us to send that summary to our AI providers.',
        },
      ],
    },
    {
      id: 'paid',
      title: 'Paid plans',
      blocks: [
        {
          p: 'You cannot buy a paid plan on this site yet: paid plans are set up by our team. Joining the waitlist is not an order and does not oblige you or us to anything. The terms of a paid plan will be agreed separately, in writing, before you pay.',
        },
      ],
    },
    {
      id: 'ip',
      title: 'Ownership',
      blocks: [
        {
          p: 'The software, the design and the name formatAI belong to us. Your files and the formats you create from them stay yours. You allow us to store the formats you save, so that we can run the service for you.',
        },
      ],
    },
    {
      id: 'termination',
      title: 'Ending your use',
      blocks: [
        {
          p: 'You can stop using formatAI at any time, and delete your saved formats on the My formats page. To close your account, write to {contactEmail}. We may limit or close an account that breaks these terms or harms the service or other people, and we may stop the service. We will give notice where we reasonably can.',
        },
      ],
    },
    {
      id: 'liability',
      title: 'No warranty and limited liability',
      blocks: [
        {
          p: 'To the extent the law allows, the service is provided "as is", without any promise that it will be error-free, uninterrupted or suitable for a particular purpose. To the extent the law allows, we are not liable for indirect or consequential loss, or for loss of profit, data or business, that comes from using the service, and our total liability for any claim is limited to the amount you paid us in the 12 months before it, which is nothing for a free account. Nothing here limits a liability that the law does not allow to be limited.',
        },
      ],
    },
    {
      id: 'changes',
      title: 'Changes to these terms',
      blocks: [{ p: 'We may change these terms. The date at the top says when they last changed. If you keep using the service after a change, you accept the new terms. When a change matters, we will say so on the site.' }],
    },
    {
      id: 'law',
      title: 'Governing law',
      blocks: [{ p: 'These terms are governed by the laws of the State of Israel. Disputes will be decided only by {jurisdiction}.' }],
    },
    {
      id: 'contact',
      title: 'Contact',
      blocks: [{ p: 'Questions about these terms: {contactEmail}. {operator}. See also the [privacy policy](/privacy) and the [accessibility statement](/accessibility).' }],
    },
  ],
};

const termsHe: LegalDoc = {
  title: 'תנאי שימוש',
  intro: 'התנאים האלה חלים כשמשתמשים ב-formatAI, שמופעלת על ידי {operator} (״אנחנו״). בשימוש בשירות אתם מסכימים להם. אם אינכם מסכימים, נא לא להשתמש בו.',
  sections: [
    {
      id: 'service',
      title: 'השירות',
      blocks: [
        {
          p: 'formatAI לומדת מדוגמה אחת איך קובץ אחד הופך לקובץ אחר, כותבת את הכללים במילים פשוטות ומפעילה אותם על הקבצים שלכם בדפדפן. השירות ניתן כפי שהוא, בגרסה מוקדמת. תכונות, מגבלות ותוכניות עשויות להשתנות, ולעיתים השירות עשוי לא להיות זמין.',
        },
      ],
    },
    {
      id: 'responsibility',
      title: 'בדיקת התוצאות היא באחריותכם',
      blocks: [
        {
          p: 'formatAI בודקת כל ערך שהיא יוצרת מול הדוגמה שלכם ומסמנת שורות שלא מתאימות, אבל היא לא יכולה להבטיח שתוצאה נכונה. כללים שנכתבו על ידי AI עלולים להיות שגויים, והתאמה לדוגמה שלכם היא בדיקה ולא הוכחה. התבוננו בתוצאה לפני שאתם משתמשים בה, במיוחד לפני שהיא נכנסת למערכת אחרת, לדוח, לתשלום או להחלטה. אנחנו לא אחראים למה שאתם עושים עם התוצאות.',
        },
        {
          p: 'אתם אחראים לכך שיש לכם זכות להשתמש בקבצים שאתם עובדים איתם, ולציית לדין החל על המידע שבהם, כולל דיני פרטיות. הסתרת הנתונים מצמצמת את מה שיוצא מהמחשב שלכם כשמשתמשים בלמידה עם AI, אבל היא לא ערובה לכך שלא נשלח שום דבר מזהה.',
        },
      ],
    },
    {
      id: 'accounts',
      title: 'החשבון שלכם',
      blocks: [
        {
          p: 'מתחברים עם חשבון Google או Microsoft. שמרו על ההתחברות שלכם ועדכנו אותנו אם אתם חושבים שמישהו אחר השתמש בחשבון. התוכניות והמגבלות מפורטות ב[דף העסקים](/business) ועשויות להשתנות; חלק מהמגבלות (כמו מספר הפורמטים עם AI) חלות על החשבון שלכם.',
        },
      ],
    },
    {
      id: 'use',
      title: 'שימוש מותר',
      blocks: [
        { p: 'נא לא:' },
        {
          ul: [
            'להשתמש בשירות לשום דבר בלתי חוקי, או לעבד קבצים שאין לכם זכות להשתמש בהם;',
            'לנסות לשבור, להעמיס, לתקוף או לפרק את השירות, או לעקוף את המגבלות, את בדיקת הבוטים או את ההגנות שלו;',
            'להשתמש בסקריפטים או בבוטים כדי לשלוח בקשות, או לשלוח טופס שלא מולא על ידי אדם;',
            'להשתמש בשלב ה-AI כדי לשלוח תוכן בלתי חוקי או מזיק, או לנסות לגרום למערכות של ספקי ה-AI להתנהג שלא כראוי;',
            'לשתף את החשבון שלכם או למכור מחדש את השירות בלי אישור שלנו בכתב.',
          ],
        },
      ],
    },
    {
      id: 'ai',
      title: 'למידה עם AI ופרטיות',
      blocks: [
        {
          p: 'למידה עם AI היא אופציונלית. מה היא שולחת ולמי כתוב ב[מדיניות הפרטיות](/privacy). בלחיצה על כפתור שמשתמש ב-AI אתם מבקשים שנשלח את הסיכום הזה לספקי ה-AI שלנו.',
        },
      ],
    },
    {
      id: 'paid',
      title: 'תוכניות בתשלום',
      blocks: [
        {
          p: 'עדיין אי אפשר לקנות תוכנית בתשלום באתר הזה: תוכניות בתשלום מוגדרות על ידי הצוות שלנו. הצטרפות לרשימת ההמתנה אינה הזמנה ואינה מחייבת אתכם או אותנו בדבר. תנאי תוכנית בתשלום יוסכמו בנפרד, בכתב, לפני שתשלמו.',
        },
      ],
    },
    {
      id: 'ip',
      title: 'בעלות',
      blocks: [
        {
          p: 'התוכנה, העיצוב והשם formatAI שייכים לנו. הקבצים שלכם והפורמטים שיצרתם מהם נשארים שלכם. אתם מתירים לנו לשמור את הפורמטים ששמרתם, כדי שנוכל להפעיל את השירות עבורכם.',
        },
      ],
    },
    {
      id: 'termination',
      title: 'סיום השימוש',
      blocks: [
        {
          p: 'אפשר להפסיק להשתמש ב-formatAI בכל עת, ולמחוק פורמטים שמורים בדף ״הפורמטים שלי״. כדי לסגור את החשבון כתבו ל-{contactEmail}. אנחנו רשאים להגביל או לסגור חשבון שמפר את התנאים האלה או פוגע בשירות או באנשים אחרים, ורשאים להפסיק את השירות. ניתן הודעה כשאפשר באופן סביר.',
        },
      ],
    },
    {
      id: 'liability',
      title: 'ללא אחריות והגבלת אחריות',
      blocks: [
        {
          p: 'במידה שהחוק מתיר, השירות ניתן ״כפי שהוא״, בלי שום הבטחה שיהיה נטול שגיאות, רציף או מתאים למטרה מסוימת. במידה שהחוק מתיר, איננו אחראים לנזק עקיף או תוצאתי, או לאובדן רווח, מידע או עסקים, הנובעים מהשימוש בשירות, והאחריות הכוללת שלנו לכל תביעה מוגבלת לסכום ששילמתם לנו ב-12 החודשים שקדמו לה, שהוא אפס בחשבון חינמי. שום דבר כאן אינו מגביל אחריות שהחוק אינו מתיר להגביל.',
        },
      ],
    },
    {
      id: 'changes',
      title: 'שינויים בתנאים',
      blocks: [{ p: 'ייתכן שנשנה את התנאים האלה. התאריך בראש הדף אומר מתי הם השתנו לאחרונה. אם תמשיכו להשתמש בשירות אחרי שינוי, אתם מקבלים את התנאים החדשים. כששינוי חשוב, נאמר זאת באתר.' }],
    },
    {
      id: 'law',
      title: 'הדין החל',
      blocks: [{ p: 'על התנאים האלה חלים דיני מדינת ישראל. מחלוקות יוכרעו אך ורק על ידי {jurisdiction}.' }],
    },
    {
      id: 'contact',
      title: 'יצירת קשר',
      blocks: [{ p: 'שאלות על התנאים: {contactEmail}. {operator}. ראו גם את [מדיניות הפרטיות](/privacy) ואת [הצהרת הנגישות](/accessibility).' }],
    },
  ],
};

const accessibilityEn: LegalDoc = {
  title: 'Accessibility statement',
  intro: 'formatAI wants everyone to be able to use it, including people with disabilities. This statement says what standard we aim for, what we did, what is still hard, and who to tell.',
  sections: [
    {
      id: 'standard',
      title: 'The standard',
      blocks: [
        {
          p: 'We aim for the Israeli Standard 5568 (IS 5568), which is based on the Web Content Accessibility Guidelines (WCAG) 2.1, level AA, as the Equal Rights for Persons with Disabilities Regulations (Service Accessibility Adjustments), 2013, require. We have not yet had the site audited by an outside body. This statement rests on our own review and testing, done on the date below.',
        },
      ],
    },
    {
      id: 'done',
      title: 'What we did',
      blocks: [
        {
          ul: [
            'Hebrew and English, each in its own direction: the whole page switches between right-to-left and left-to-right, and the language of the page is declared.',
            'Every page has a title, a skip link to the main content, and headings and landmarks in a sensible order.',
            'The main flows can be done with the keyboard alone, the focus is visible, and dialogs hold the focus and close with Escape.',
            'Form fields have labels, hints and error messages that say what to fix, and the fields are marked as required or optional.',
            'The brand colours were checked for contrast against the page background, in the light and the dark theme.',
            'Text can be enlarged to 200% with the browser, and the page keeps working without sideways scrolling on a phone.',
            'Animations are gentle, and they stop when your system asks for less motion.',
            'An accessibility button on every page opens a panel where you can enlarge the text, turn on high contrast, underline links, use a more readable font, stop animations, strengthen the focus highlight and widen the spacing between lines and letters. Your choices are kept in this browser only.',
          ],
        },
      ],
    },
    {
      id: 'limits',
      title: 'What is still hard',
      blocks: [
        {
          ul: [
            'The previews of spreadsheets (the example, the result and the rows to check) are large tables. They can be tiring to move through with a screen reader or the keyboard, and we have not made them as easy as an ordinary table of a few rows.',
            'The rules editor has many controls on one screen. We tested it with the keyboard, but not yet with every screen reader.',
            'We have tested with the keyboard and with automated checks. Testing with screen readers such as NVDA, JAWS and VoiceOver is still to be done, so there may be problems we have not found.',
            "The files you work with are yours: formatAI makes the output file look like the example you gave it, and cannot make a file accessible if the example is not.",
            "Some parts are run by others and are outside our control: the sign-in pages of Google and Microsoft, and Cloudflare's anti-bot check.",
          ],
        },
        { p: 'If something blocks you, please tell us. We will look for another way to get you what you need, and fix the problem.' },
      ],
    },
    {
      id: 'contact',
      title: 'Accessibility coordinator and contact',
      blocks: [
        { p: 'To report a problem, ask for help, or suggest an improvement, contact our accessibility coordinator:' },
        { ul: ['Name: {a11yCoordinator}', 'Email: {a11yEmail}', 'Phone: {a11yPhone}'] },
        { p: 'Please say which page and which device, browser or assistive technology you used. We will answer as soon as we can.' },
      ],
    },
    {
      id: 'date',
      title: 'Date of this statement',
      blocks: [{ p: 'This statement was last updated on {date}. See also the [privacy policy](/privacy) and the [terms of use](/terms).' }],
    },
  ],
};

const accessibilityHe: LegalDoc = {
  title: 'הצהרת נגישות',
  intro: 'ב-formatAI רוצים שכל אחד יוכל להשתמש בשירות, כולל אנשים עם מוגבלות. ההצהרה הזו אומרת לאיזה תקן אנחנו שואפים, מה עשינו, מה עדיין קשה ולמי אפשר לפנות.',
  sections: [
    {
      id: 'standard',
      title: 'התקן',
      blocks: [
        {
          p: 'אנחנו שואפים לעמוד בתקן הישראלי ת״י 5568, המבוסס על הנחיות הנגישות לתוכן אינטרנט (WCAG) 2.1 ברמה AA, כפי שדורשות תקנות שוויון זכויות לאנשים עם מוגבלות (התאמות נגישות לשירות), התשע״ג-2013. עדיין לא ערכנו ביקורת חיצונית לאתר. ההצהרה מבוססת על בדיקה ובחינה שערכנו בעצמנו, בתאריך שמופיע בהמשך.',
        },
      ],
    },
    {
      id: 'done',
      title: 'מה עשינו',
      blocks: [
        {
          ul: [
            'עברית ואנגלית, כל אחת בכיוון שלה: כל הדף מתהפך בין ימין לשמאל ובין שמאל לימין, ושפת הדף מוצהרת.',
            'לכל דף יש כותרת, קישור דילוג לתוכן הראשי, וכותרות ואזורי עמוד (landmarks) בסדר הגיוני.',
            'את התהליכים העיקריים אפשר לעשות במקלדת בלבד, הפוקוס נראה, וחלונות קופצים שומרים את הפוקוס וסוגרים ב-Escape.',
            'לשדות בטפסים יש תוויות, הסברים והודעות שגיאה שאומרות מה לתקן, והשדות מסומנים כחובה או כרשות.',
            'צבעי המותג נבדקו מבחינת ניגודיות מול רקע הדף, בערכת הנושא הבהירה והכהה.',
            'אפשר להגדיל את הטקסט עד 200% בדפדפן, והדף ממשיך לעבוד בלי גלילה לצדדים בטלפון.',
            'האנימציות עדינות, והן נעצרות כשהמערכת שלכם מבקשת פחות תנועה.',
            'כפתור נגישות בכל דף פותח חלונית שבה אפשר להגדיל את הטקסט, להפעיל ניגודיות גבוהה, להוסיף קו תחתון לקישורים, להשתמש בגופן קריא יותר, לעצור אנימציות, להדגיש את הפוקוס ולהרחיב את הריווח בין שורות ואותיות. הבחירות שלכם נשמרות בדפדפן הזה בלבד.',
          ],
        },
      ],
    },
    {
      id: 'limits',
      title: 'מה עדיין קשה',
      blocks: [
        {
          ul: [
            'התצוגות המקדימות של גיליונות (הדוגמה, התוצאה והשורות לבדיקה) הן טבלאות גדולות. קשה לעיתים להתמצא בהן עם קורא מסך או במקלדת, ולא הפכנו אותן לנוחות כמו טבלה רגילה של כמה שורות.',
            'בעורך הכללים יש הרבה פקדים במסך אחד. בדקנו אותו במקלדת, אבל עדיין לא בכל קורא מסך.',
            'בדקנו במקלדת ובבדיקות אוטומטיות. בדיקה עם קוראי מסך כמו NVDA, JAWS ו-VoiceOver עוד לפנינו, ולכן ייתכנו בעיות שלא מצאנו.',
            'הקבצים שאתם עובדים איתם הם שלכם: formatAI מעצבת את קובץ הפלט כמו הדוגמה שנתתם לה, ולא יכולה להפוך קובץ לנגיש אם הדוגמה אינה נגישה.',
            'חלקים מסוימים מופעלים על ידי אחרים ומחוץ לשליטתנו: דפי ההתחברות של Google ו-Microsoft, ובדיקת הבוטים של Cloudflare.',
          ],
        },
        { p: 'אם משהו חוסם אתכם, נשמח שתספרו לנו. נחפש דרך אחרת לתת לכם את מה שאתם צריכים, ונתקן את הבעיה.' },
      ],
    },
    {
      id: 'contact',
      title: 'רכז נגישות ופרטי קשר',
      blocks: [
        { p: 'כדי לדווח על בעיה, לבקש עזרה או להציע שיפור, פנו לרכז הנגישות שלנו:' },
        { ul: ['שם: {a11yCoordinator}', 'אימייל: {a11yEmail}', 'טלפון: {a11yPhone}'] },
        { p: 'ציינו באיזה דף, ובאיזה מכשיר, דפדפן או טכנולוגיה מסייעת השתמשתם. נענה בהקדם האפשרי.' },
      ],
    },
    {
      id: 'date',
      title: 'תאריך ההצהרה',
      blocks: [{ p: 'ההצהרה עודכנה לאחרונה ב-{date}. ראו גם את [מדיניות הפרטיות](/privacy) ואת [תנאי השימוש](/terms).' }],
    },
  ],
};

export const legalDocs: Record<LegalPageId, Record<Lang, LegalDoc>> = {
  privacy: { en: privacyEn, he: privacyHe },
  terms: { en: termsEn, he: termsHe },
  accessibility: { en: accessibilityEn, he: accessibilityHe },
};
