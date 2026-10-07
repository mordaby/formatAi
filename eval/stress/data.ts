// The stress test's raw material (eval/STRESS.md): seeded value generators for every kind of column a messy real file holds - Hebrew and
// English names and text, IDs stored as text with leading zeros or as numbers, amounts as numbers or as text with a currency sign and
// thousands separators, dates as real dates, as text in several formats or as bare Excel serials - plus the "mess" applied on top
// (spaces, non-breaking spaces, RTL/LTR marks, emoji, very long text, cells that start with = + - @). No engine code: what a value IS
// is decided here, never by the engine under test.
import { makeValidIsraeliId, ymdToSerial } from '@formatai/engine';
import { chance, pick, randInt, type Rng } from '../cases/lib/prng';
import { EN_CITIES, EN_COMPANIES, EN_FIRST, EN_LAST, EN_PRODUCTS, HE_CITIES, HE_COMPANIES, HE_FIRST, HE_LAST, HE_PRODUCTS, randDate } from '../catalogue/data';
import type { Ymd } from '../catalogue/types';

export type Lang = 'he' | 'en';

/** One cell as the generator means it; the file writer turns it into xlsx / csv / txt (`files.ts`). */
export type GenCell =
  | null
  /** Text. */
  | { s: string }
  /** A number cell (xlsx), with an optional number format; plain digits in a delimited file. */
  | { n: number; z?: string }
  /** A real date cell (xlsx, with its format); in a delimited file the text `csvFormat` writes. */
  | { d: Ymd; z: string };

/** What a column holds, in the generator's own words. */
export type ColKind =
  | 'name'
  | 'company'
  | 'city'
  | 'category'
  | 'text'
  | 'longText'
  | 'idText'
  | 'idNum'
  | 'israeliId'
  | 'code'
  | 'int'
  | 'decimal'
  | 'money'
  | 'date'
  | 'dateText'
  | 'dateSerial'
  | 'phone'
  | 'email'
  | 'multi'
  | 'formula';

export const TEXT_KINDS: ReadonlySet<ColKind> = new Set(['name', 'company', 'city', 'category', 'text', 'longText', 'idText', 'code', 'phone', 'email', 'multi', 'formula']);
export const NUMBER_KINDS: ReadonlySet<ColKind> = new Set(['int', 'decimal', 'money']);
export const DATE_KINDS: ReadonlySet<ColKind> = new Set(['date', 'dateText', 'dateSerial']);
/** Kinds whose values are personal or identifying: what masking must never send real (invariant 4). */
export const SENSITIVE_KINDS: ReadonlySet<ColKind> = new Set(['name', 'company', 'text', 'longText', 'idText', 'idNum', 'israeliId', 'code', 'phone', 'email', 'multi', 'formula']);

export interface InCol {
  /** The rules id (ascii). */
  id: string;
  header: string;
  kind: ColKind;
  lang: Lang;
  /** Share of empty cells. */
  emptyRate: number;
  /** Share of text cells given spaces, a non-breaking space or a direction mark. */
  messRate: number;
  /** Share of cells that start with = + - @ (text kinds), or of junk text cells (number and date kinds). */
  injectRate: number;
  /** category / multi: the values. */
  vocab?: string[];
  /** dateText: the format the text is written in. */
  dateFormat?: string;
  /** idText: the width the zero-padded IDs have; idNum: the number of digits. */
  width?: number;
  /** idNum / idText / code: one value per row (true) or a pool of repeating values. */
  unique?: boolean;
  /** int / decimal / money: the value range; decimal / money: whether negative values occur. */
  range?: [number, number];
  negatives?: boolean;
  /** money: how the amounts are written. */
  moneyStyle?: 'shekel' | 'dollar' | 'grouped' | 'mixed';
  /** israeliId: stored as a number (leading zeros lost) or as text. */
  asNumber?: boolean;
  /** multi: the separator between items. */
  separator?: string;
  /** code: the prefix. */
  prefix?: string;
  /** Allow names in scripts the masker has no fake alphabet for (Arabic, Cyrillic, accented Latin). */
  otherScripts?: boolean;
  /**
   * name: every value is one of these few names of other scripts (an account manager on every row). Engine audit (2026-10-07): a column
   * of few shapes gets a `shape` in the payload, which sent such names whole.
   */
  scriptPool?: string[];
  /** Emoji in text. */
  emoji?: boolean;
}

// ---------------------------------------------------------------------------
// Word pools
// ---------------------------------------------------------------------------

const HE_STATUS = ['פעיל', 'לא פעיל', 'ממתין', 'מבוטל', 'סגור', 'בטיפול'];
const EN_STATUS = ['Active', 'Inactive', 'Pending', 'Cancelled', 'Closed', 'On hold'];
const HE_DEPT = ['מכירות', 'רכש', 'כספים', 'לוגיסטיקה', 'שיווק', 'משאבי אנוש', 'שירות'];
const EN_DEPT = ['Sales', 'Procurement', 'Finance', 'Logistics', 'Marketing', 'HR', 'Support'];
const HE_WORDS = ['לקוח', 'הזמנה', 'משלוח', 'דחוף', 'אושר', 'נא', 'לבדוק', 'חשבונית', 'תשלום', 'מחסן', 'ספק', 'הנחה', 'החזרה', 'פגום', 'מלאי', 'סניף', 'צפון', 'דרום'];
const EN_WORDS = ['customer', 'order', 'shipment', 'urgent', 'approved', 'please', 'check', 'invoice', 'payment', 'warehouse', 'supplier', 'discount', 'return', 'damaged', 'stock', 'branch', 'north', 'south'];
/** Names in scripts the masker does not model (it keeps their letters as they are). */
const OTHER_SCRIPT_NAMES = ['محمد خليل', 'أحمد سعيد', 'Сергей Иванов', 'Ольга Петрова', 'José Muñoz', 'Zoë Brontë', 'François Dubois'];
const EMOJI = ['😀', '👍', '🚚', '✅', '⚠️', '📦', '🔥'];
/** Text that starts like a formula: what a CSV / XLSX writer must never turn into a live one. */
const INJECTIONS = ['=1+1', '=SUM(A1:A9)', '+972-50-1234567', '-מבוטל-', '@user', '=HYPERLINK("http://example.com","x")', '=cmd|\' /C calc\'!A0', '-5 units', '+ bonus', '@SUM(1,2)', "=2*3"];
const DATE_TEXT_FORMATS = ['DD/MM/YYYY', 'YYYY-MM-DD', 'D.M.YYYY', 'DD-MM-YY', 'D/M/YYYY'];

const HEADERS: Record<ColKind, { he: string[]; en: string[] }> = {
  name: { he: ['שם לקוח', 'שם מלא', 'שם עובד', 'איש קשר'], en: ['Customer Name', 'Full Name', 'Employee', 'Contact'] },
  company: { he: ['ספק', 'חברה', 'שם ספק'], en: ['Supplier', 'Company', 'Vendor'] },
  city: { he: ['עיר', 'יישוב'], en: ['City', 'Town'] },
  category: { he: ['סטטוס', 'מחלקה', 'מוצר', 'סוג'], en: ['Status', 'Department', 'Product', 'Type'] },
  text: { he: ['הערות', 'תיאור'], en: ['Notes', 'Description', 'Comment'] },
  longText: { he: ['פירוט', 'הערה ארוכה'], en: ['Details', 'Long Note'] },
  idText: { he: ['מק"ט', 'קוד לקוח', 'מספר חשבון'], en: ['SKU', 'Customer Code', 'Account No'] },
  idNum: { he: ['מספר לקוח', 'מספר הזמנה'], en: ['Customer No', 'Order No'] },
  israeliId: { he: ['ת.ז.', 'תעודת זהות'], en: ['ID Number', 'National ID'] },
  code: { he: ['אסמכתא', 'מספר חשבונית'], en: ['Reference', 'Invoice'] },
  int: { he: ['כמות', 'יחידות'], en: ['Qty', 'Units'] },
  decimal: { he: ['סכום', 'מחיר', 'משקל'], en: ['Amount', 'Price', 'Weight'] },
  money: { he: ['סכום כולל', 'עלות'], en: ['Total', 'Cost'] },
  date: { he: ['תאריך', 'תאריך הזמנה'], en: ['Date', 'Order Date'] },
  dateText: { he: ['תאריך תשלום', 'תאריך אספקה'], en: ['Payment Date', 'Delivery Date'] },
  dateSerial: { he: ['תאריך רישום'], en: ['Registered'] },
  phone: { he: ['טלפון', 'נייד'], en: ['Phone', 'Mobile'] },
  email: { he: ['דוא"ל', 'אימייל'], en: ['Email', 'E-mail'] },
  multi: { he: ['תגיות', 'פריטים'], en: ['Tags', 'Items'] },
  formula: { he: ['נוסחה', 'הערת מערכת'], en: ['Formula', 'System Note'] },
};

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

const KIND_WEIGHTS: [ColKind, number][] = [
  ['name', 8], ['company', 4], ['city', 4], ['category', 9], ['text', 5], ['longText', 2], ['idText', 6], ['idNum', 6], ['israeliId', 3],
  ['code', 5], ['int', 8], ['decimal', 10], ['money', 6], ['date', 7], ['dateText', 5], ['dateSerial', 2], ['phone', 3], ['email', 3],
  ['multi', 3], ['formula', 2],
];

function weightedKind(rng: Rng): ColKind {
  const total = KIND_WEIGHTS.reduce((a, [, w]) => a + w, 0);
  let r = rng() * total;
  for (const [k, w] of KIND_WEIGHTS) {
    r -= w;
    if (r < 0) return k;
  }
  return 'text';
}

/** A short ascii id from the kind and its position (`c3Amount` style ids are noise; these read well in a repro). */
function colId(kind: ColKind, i: number): string {
  return `${kind}${i + 1}`;
}

export interface ColumnOptions {
  /** Columns in the case's language, or each column in its own. */
  lang: Lang | 'mixed';
  inject: boolean;
  mess: boolean;
  empties: boolean;
  otherScripts: boolean;
  emoji: boolean;
}

/** `n` columns of random kinds (at least one the rules can copy), unique headers. */
export function makeColumns(rng: Rng, n: number, opts: ColumnOptions): InCol[] {
  const cols: InCol[] = [];
  const used = new Set<string>();
  for (let i = 0; i < n; i++) {
    const kind = weightedKind(rng);
    const lang: Lang = opts.lang === 'mixed' ? (chance(rng, 0.5) ? 'he' : 'en') : opts.lang;
    let header = pick(rng, HEADERS[kind][lang]);
    for (let k = 2; used.has(header); k++) header = `${pick(rng, HEADERS[kind][lang])} ${k}`;
    used.add(header);
    const col: InCol = {
      id: colId(kind, i),
      header,
      kind,
      lang,
      emptyRate: opts.empties && chance(rng, 0.35) ? pick(rng, [0.02, 0.05, 0.1, 0.3]) : 0,
      messRate: opts.mess && TEXT_KINDS.has(kind) && chance(rng, 0.4) ? pick(rng, [0.03, 0.1, 0.25]) : 0,
      injectRate: 0,
    };
    if (opts.inject) {
      if (kind === 'formula') col.injectRate = 0.5;
      else if (TEXT_KINDS.has(kind) && chance(rng, 0.25)) col.injectRate = pick(rng, [0.02, 0.05]);
      else if ((NUMBER_KINDS.has(kind) || DATE_KINDS.has(kind)) && chance(rng, 0.2)) col.injectRate = 0.02;
    }
    switch (kind) {
      case 'category': {
        const pool = pick(rng, [lang === 'he' ? HE_STATUS : EN_STATUS, lang === 'he' ? HE_DEPT : EN_DEPT, lang === 'he' ? HE_PRODUCTS : EN_PRODUCTS]);
        col.vocab = pool.slice(0, randInt(rng, 2, Math.min(6, pool.length)));
        break;
      }
      case 'multi':
        col.vocab = (lang === 'he' ? HE_WORDS : EN_WORDS).slice(0, randInt(rng, 4, 10));
        col.separator = pick(rng, ['; ', ';', ', ', ' | ']);
        break;
      case 'dateText':
        col.dateFormat = pick(rng, DATE_TEXT_FORMATS);
        break;
      case 'idText':
        col.width = randInt(rng, 5, 10);
        col.unique = chance(rng, 0.7);
        break;
      case 'idNum':
        col.width = randInt(rng, 7, 9);
        col.unique = chance(rng, 0.7);
        break;
      case 'code':
        col.prefix = pick(rng, ['INV-', 'PO', 'ח-', 'REF/', 'A']);
        col.unique = chance(rng, 0.8);
        break;
      case 'israeliId':
        col.asNumber = chance(rng, 0.6);
        break;
      case 'int':
        col.range = pick(rng, [[0, 20], [1, 999], [0, 5000]] as [number, number][]);
        break;
      case 'decimal':
        col.range = pick(rng, [[0, 100], [1, 5000], [10, 250000]] as [number, number][]);
        col.negatives = chance(rng, 0.2);
        break;
      case 'money':
        col.range = pick(rng, [[1, 999], [10, 20000], [100, 1000000]] as [number, number][]);
        col.moneyStyle = pick(rng, ['shekel', 'dollar', 'grouped', 'mixed'] as const);
        col.negatives = chance(rng, 0.1);
        break;
      case 'name':
        col.otherScripts = opts.otherScripts && chance(rng, 0.5);
        break;
      case 'text':
      case 'longText':
        col.emoji = opts.emoji && chance(rng, 0.5);
        break;
      default:
        break;
    }
    cols.push(col);
  }
  return cols;
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

export interface ValueState {
  /** Per column: the next unique number (idNum / idText / code), so a file's IDs never repeat. */
  next: Map<string, number>;
  /** Per column: the pool of repeating values (non-unique IDs). */
  pools: Map<string, string[]>;
}

export function newValueState(): ValueState {

  return { next: new Map(), pools: new Map() };
}

/** A few names of other scripts for a `scriptPool` column. */
export function scriptPoolOf(rng: Rng): string[] {
  const pool = [...OTHER_SCRIPT_NAMES];
  const out: string[] = [];
  for (let i = 0; i < 3; i++) out.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]!);
  return out;
}

function fullName(rng: Rng, col: InCol): string {
  if (col.scriptPool) return pick(rng, col.scriptPool);
  if (col.otherScripts && chance(rng, 0.1)) return pick(rng, OTHER_SCRIPT_NAMES);
  return col.lang === 'he' ? `${pick(rng, HE_FIRST)} ${pick(rng, HE_LAST)}` : `${pick(rng, EN_FIRST)} ${pick(rng, EN_LAST)}`;
}

function sentence(rng: Rng, lang: Lang, words: number, emoji: boolean): string {
  const parts: string[] = [];
  for (let i = 0; i < words; i++) {
    const r = rng();
    if (r < 0.12) parts.push(lang === 'he' ? pick(rng, HE_FIRST) : pick(rng, EN_FIRST));
    else if (r < 0.2) parts.push(String(randInt(rng, 1, 999)));
    else if (r < 0.28) parts.push(pick(rng, lang === 'he' ? EN_WORDS : HE_WORDS)); // the other language mixed in
    else parts.push(pick(rng, lang === 'he' ? HE_WORDS : EN_WORDS));
  }
  let s = parts.join(' ');
  if (emoji && chance(rng, 0.2)) s = chance(rng, 0.5) ? `${pick(rng, EMOJI)} ${s}` : `${s} ${pick(rng, EMOJI)}`;
  return s;
}

function digits(rng: Rng, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += String(randInt(rng, 0, 9));
  return s;
}

/** The next value of a unique-or-pooled ID column: `make(n)` turns a counter into the value. */
function idValue(rng: Rng, col: InCol, st: ValueState, variant: 'example' | 'next', make: (n: number) => string): string {
  if (col.unique) {
    // Fresh rows next month: a disjoint range of counters.
    const start = 1000;
    const n = (st.next.get(col.id) ?? start) + randInt(rng, 1, 37);
    st.next.set(col.id, n);
    return make(n);
  }
  let pool = st.pools.get(col.id);
  if (!pool) {
    pool = [];
    for (let i = 0; i < 12; i++) pool.push(make(randInt(rng, 100, 99999)));
    st.pools.set(col.id, pool);
  }
  return pick(rng, pool);
}

function shekel(x: number): string {
  return `₪${fmtGrouped(x, 2)}`;
}
function fmtGrouped(x: number, decimals: number): string {
  const s = Math.abs(x).toFixed(decimals);
  const [i = '', f] = s.split('.');
  const g = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${x < 0 ? '-' : ''}${g}${f !== undefined ? `.${f}` : ''}`;
}

/** A number with two decimals in [a, b] (exact cents). */
function amount(rng: Rng, a: number, b: number): number {
  return randInt(rng, Math.round(a * 100), Math.round(b * 100)) / 100;
}

function dateIn(rng: Rng): Ymd {
  return randDate(rng, 2024, 2026, true);
}

export function formatDateText(d: Ymd, format: string): string {
  const p2 = (n: number): string => String(n).padStart(2, '0');
  return format
    .replace('YYYY', String(d.y))
    .replace('YY', p2(d.y % 100))
    .replace('DD', p2(d.d))
    .replace('MM', p2(d.m))
    .replace(/D/, String(d.d))
    .replace(/M/, String(d.m));
}

/** The plain value of one cell, before the mess (see `messUp`). */
function cleanValue(rng: Rng, col: InCol, st: ValueState, variant: 'example' | 'next'): GenCell {
  switch (col.kind) {
    case 'name':
      return { s: fullName(rng, col) };
    case 'company':
      return { s: `${pick(rng, col.lang === 'he' ? HE_COMPANIES : EN_COMPANIES)}${chance(rng, 0.3) ? (col.lang === 'he' ? ' בע"מ' : ' Ltd') : ''}` };
    case 'city':
      return { s: pick(rng, col.lang === 'he' ? HE_CITIES : EN_CITIES) };
    case 'category':
      return { s: pick(rng, col.vocab!) };
    case 'text':
      return { s: sentence(rng, col.lang, randInt(rng, 2, 7), col.emoji === true) };
    case 'longText': {
      const long = chance(rng, 0.05) ? randInt(rng, 120, 400) : randInt(rng, 10, 40);
      return { s: sentence(rng, col.lang, long, col.emoji === true) };
    }
    case 'idText':
      return { s: idValue(rng, col, st, variant, (n) => String(n).padStart(col.width!, '0')) };
    case 'idNum':
      return { n: Number(idValue(rng, col, st, variant, (n) => String(10 ** (col.width! - 1) + n * 7919 % (9 * 10 ** (col.width! - 1))))) };
    case 'israeliId': {
      // A quarter of real IDs start with 0: stored as a number they lose it.
      const seed8 = chance(rng, 0.25) ? `0${digits(rng, 7)}` : `${randInt(rng, 1, 3)}${digits(rng, 7)}`;
      const id = makeValidIsraeliId(seed8);
      return col.asNumber ? { n: Number(id) } : { s: id };
    }
    case 'code':
      return { s: idValue(rng, col, st, variant, (n) => `${col.prefix}${n}`) };
    case 'int': {
      const [a, b] = col.range!;
      return { n: randInt(rng, a, b) };
    }
    case 'decimal': {
      const [a, b] = col.range!;
      const v = amount(rng, a, b);
      return { n: col.negatives && chance(rng, 0.15) ? -v : v, ...(chance(rng, 0.5) ? { z: '#,##0.00' } : {}) };
    }
    case 'money': {
      const [a, b] = col.range!;
      const v = col.negatives && chance(rng, 0.1) ? -amount(rng, a, b) : amount(rng, a, b);
      const style = col.moneyStyle === 'mixed' ? pick(rng, ['shekel', 'dollar', 'grouped', 'number'] as const) : col.moneyStyle!;
      if (style === 'shekel') return { s: v < 0 ? `-${shekel(-v)}` : shekel(v) };
      if (style === 'dollar') return { s: `$ ${fmtGrouped(v, 2)}` };
      if (style === 'grouped') return { s: fmtGrouped(v, 2) };
      return { n: v, z: '#,##0.00 ₪' };
    }
    case 'date':
      return { d: dateIn(rng), z: 'dd/mm/yyyy' };
    case 'dateText':
      return { s: formatDateText(dateIn(rng), col.dateFormat!) };
    case 'dateSerial':
      return { n: ymdToSerial(dateIn(rng)) };
    case 'phone':
      return { s: chance(rng, 0.5) ? `05${randInt(rng, 0, 9)}-${digits(rng, 7)}` : `05${randInt(rng, 0, 9)}${digits(rng, 7)}` };
    case 'email':
      return { s: `${pick(rng, EN_FIRST).toLowerCase()}.${pick(rng, EN_LAST).toLowerCase()}${randInt(rng, 1, 99)}@example.com` };
    case 'multi': {
      const k = randInt(rng, 1, 4);
      const items: string[] = [];
      for (let i = 0; i < k; i++) items.push(pick(rng, col.vocab!));
      return { s: items.join(col.separator!) };
    }
    case 'formula':
      return { s: sentence(rng, col.lang, randInt(rng, 1, 4), false) };
  }
}

const MESS: ((s: string) => string)[] = [
  (s) => ` ${s}`,
  (s) => `${s}  `,
  (s) => s.replace(' ', ' '),
  (s) => `‏${s}`,
  (s) => `${s}‎`,
  (s) => ` ${s} `,
];

/** One cell of `col`: empty, junk (an injection), messy, or clean. */
export function cellValue(rng: Rng, col: InCol, st: ValueState, variant: 'example' | 'next'): GenCell {
  if (col.emptyRate > 0 && chance(rng, col.emptyRate)) return chance(rng, 0.2) ? { s: chance(rng, 0.5) ? '' : ' ' } : null;
  if (col.injectRate > 0 && chance(rng, col.injectRate)) return { s: pick(rng, INJECTIONS) };
  const v = cleanValue(rng, col, st, variant);
  if (v !== null && 's' in v && col.messRate > 0 && chance(rng, col.messRate)) return { s: pick(rng, MESS)(v.s) };
  return v;
}
