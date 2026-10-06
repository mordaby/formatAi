// The masking switch (SPEC 7.2): what is vocabulary rather than personal data, and so is sent as it is with masking on.
// A list in config, like the footer labels (`detection.ts`), so a new spelling can be added without touching the engine.

export const maskingVocabulary = {
  /**
   * Placeholders that mean "no value" (SPEC 7.2, learning-loop proposal 7.5): a cell that is EXACTLY one of these is sent as
   * it is, never masked - a cleanup rule ("N/A" -> empty) cannot be learned from a masked "O/F". Compared case-insensitively
   * and with every space removed ("n / a" is "N/A", "לא  ידוע" is "לא ידוע"); only the whole cell counts, so a name next to
   * one is masked as before. Punctuation-only tokens ("-", "?") are never masked anyway (only words are), and are listed
   * here so the list says everything in one place.
   */
  noValueTokens: ['N/A', 'NA', 'n.a.', '#N/A', '-', '--', '—', '–', 'null', 'none', 'nil', '?', 'אין', 'לא ידוע', 'ריק', 'ללא'],
} as const;

/**
 * Amendment 2026-10-06 (SPEC 7.2): identifiers stored as numbers are masked - which columns are identifiers is the column classification's
 * (below; engine `learn/classify.ts`).
 */
export const maskingIdentifiers = {
  /**
   * A NUMBER constant in the rules the AI returns is unmasked only when it is the fake of an ID of at least this many digits (a fake
   * written as text is unmasked whatever its length, as before). DECISION: a short number in a rule (a rate, a threshold, 100, 1000) is
   * far more likely a real constant than the fake of a short code, and with 1-3 digits a fake collides with one often (a code of 1..9
   * takes nearly every one-digit number); from 4 digits on a collision is rare (50 codes cover under 1% of the 4-digit numbers).
   */
  minUnmaskDigits: 4,
} as const;

/**
 * Column classification (owner, 2026-10-06; engine `learn/classify.ts`, SPEC 21 "column classification"): words in a column's NAME that
 * say what it holds, Hebrew and English. A name is compared as `normalizeColumnName` writes it - case, spaces, punctuation and geresh /
 * gershayim ignored ("ת"ז", "ת.ז.", "מס' לקוח", "Customer No.", "customer_id") - word by word: an entry is a whole word or a run of whole
 * words of the name ("Valid" does not hold "id"), a Hebrew word with one prefix letter too ("הטלפון").
 */
export const columnNames = {
  /** An identifier: the column is masked, even when its values are numbers that repeat (a customer number on every order). */
  identifier: [
    'ת.ז', 'ת"ז', 'תעודת זהות', 'מספר זהות', "מס' לקוח", 'מספר לקוח', 'קוד לקוח', 'חשבון', 'מספר חשבון', 'טלפון', 'נייד', 'מייל', 'אימייל',
    'דוא"ל', 'פוליסה', 'דרכון',
    'id', 'customer no', 'customer number', 'account', 'account no', 'phone', 'mobile', 'email', 'e-mail', 'policy', 'passport', 'iban',
  ],
  /**
   * A measure: a numeric column stays a measure, sent real, however long its numbers (a 1,000,000 price). It wins over an identifier word
   * in the same name ("סכום חשבון", "Account balance"): the name says what of the account the column holds.
   */
  measure: [
    'מחיר', 'סכום', 'סה"כ', 'כמות', 'שיעור', 'עמלה', 'עמלת', 'עלות', 'יתרה', 'יתרת',
    'price', 'amount', 'total', 'qty', 'quantity', 'rate', 'fee', 'cost', 'sum', 'balance',
  ],
  /** A person: what an external classification may never loosen to a category (with an identifier word: `ColumnHints` in the engine). */
  person: ['שם', 'משפחה', 'איש קשר', 'כתובת', 'לקוח', 'עובד', 'name', 'surname', 'contact', 'address', 'customer', 'employee'],
} as const;

/**
 * The column classification's classes (owner, 2026-10-06; engine `learn/classify.ts`): masking sends an `identifier` (ID numbers, customer,
 * account and policy numbers, phones, emails, card numbers, IBANs) and `text` (names, free text) masked, and a `measure` (amounts,
 * quantities, rates), a `date` and a `category` (a few values repeated - only when an external classification and code agree) real.
 */
export const COLUMN_CLASSES = ['identifier', 'text', 'category', 'measure', 'date'] as const;
export type ColumnClass = (typeof COLUMN_CLASSES)[number];

/**
 * What an external classification (the AI step, later) may say about a column, by its header (`ColumnClassHints`; engine
 * `classifyColumns`): it may tighten freely - anything can become masked - and loosen only a text column to a `category`, when code
 * confirms it (`columnClassification.category`). `person` and `contact` are masked like an identifier; `measure` and `date` never loosen.
 */
export const COLUMN_CLASS_HINTS = ['identifier', 'person', 'contact', 'measure', 'category', 'date', 'text'] as const;
export type ColumnClassHint = (typeof COLUMN_CLASS_HINTS)[number];
/** An external classification: a hint per column header (input or output; compared as `normalizeColumnName` writes them). */
export type ColumnClassHints = Readonly<Record<string, ColumnClassHint>>;

/** The column classification's thresholds (engine `learn/classify.ts`). */
export const columnClassification = {
  /** A column is an identifier by its values when at least this share of its non-empty cells (of those read) have one identifier shape. */
  shapeShare: 0.8,
  /** The cells read for the shapes, spread over the column. */
  shapeSample: 500,
  /**
   * An external classification may loosen a text column to a category (sent real) only when code confirms it: at most `maxValues` distinct
   * values, each on at least `minRowsPerValue` rows, no cell with an identifier shape, and no identifier or person word in its name.
   */
  category: { maxValues: 12, minRowsPerValue: 2 },
} as const;

/** Hebrew prefix letters a word of a column name may carry ("הטלפון", "ולקוח"). */
const HEBREW_PREFIXES = 'הובלמשכ';

/**
 * A column name as the name words are compared (`columnNames`): words split at a change from lower to upper case, lower case, geresh,
 * gershayim, quotes and periods dropped ("ת.ז." -> "תז", "מס' לקוח" -> "מס לקוח"), "#" and "№" read as "no", every other mark a space.
 */
export function normalizeColumnName(name: string): string {
  return name
    .replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2')
    .toLowerCase()
    .replace(/['"`׳״‘’“”.]/g, '')
    .replace(/[#№]/g, ' no ')
    .replace(/[^\p{L}\p{Nd}]+/gu, ' ')
    .trim();
}

/** One word of a name against one word of an entry: the same, or (Hebrew) the entry's word with one prefix letter in front. */
function sameWord(nameWord: string, entryWord: string): boolean {
  return nameWord === entryWord || (nameWord.length === entryWord.length + 1 && HEBREW_PREFIXES.includes(nameWord[0]!) && nameWord.endsWith(entryWord) && /[א-ת]/.test(entryWord));
}

/** Whether a column name holds one of the entries of a `columnNames` list (see `columnNames`). */
export function nameHolds(name: string, list: readonly string[]): boolean {
  const words = normalizeColumnName(name).split(' ').filter((w) => w !== '');
  return list.some((entry) => {
    const e = normalizeColumnName(entry).split(' ');
    for (let i = 0; i + e.length <= words.length; i++) if (e.every((w, k) => sameWord(words[i + k]!, w))) return true;
    return false;
  });
}
