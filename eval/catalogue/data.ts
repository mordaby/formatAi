// Word pools and small helpers for the catalogue's generators and oracles. Everything here is plain TypeScript, with no
// dependency on the engine: the oracle (the expected output) must stay independent of the code under test.
import { pick, randInt, type Rng } from '../cases/lib/prng';
import type { GenCtx, Row, Ymd } from './types';

// ---------- Word pools (Hebrew and English) ----------

export const HE_FIRST = ['דנה', 'יוסי', 'מאיה', 'עומר', 'שירה', 'אבי', 'נועה', 'תומר', 'רותם', 'אלי', 'גל', 'מיכל', 'רון', 'ליאור', 'הילה', 'אורי', 'טל', 'נעמה', 'יובל', 'שני'];
export const HE_LAST = ['כהן', 'לוי', 'מזרחי', 'פרץ', 'ביטון', 'אזולאי', 'דהן', 'אברהם', 'גבאי', 'חדד', 'אוחיון', 'מלכה', 'שרעבי', 'קדוש', 'נחמיאס'];
export const EN_FIRST = ['Dana', 'Yossi', 'Maya', 'Omer', 'Shira', 'Avi', 'Noa', 'Tomer', 'Rotem', 'Eli', 'Gal', 'Michelle', 'Ron', 'Lior', 'Hila', 'James', 'Laura', 'Kevin', 'Maria', 'Daniel'];
export const EN_LAST = ['Cohen', 'Levi', 'Mizrahi', 'Peretz', 'Bitton', 'Azoulay', 'Dahan', 'Abraham', 'Gabbay', 'Haddad', 'Miller', 'Johnson', 'Smith', 'Brown', 'Davis'];
export const HE_MIDDLE = ['בן', 'בת', 'אבו', 'אל'];
export const EN_MIDDLE = ['Lee', 'Ann', 'James', 'Rose', 'Ben'];

export const HE_CITIES = ['תל אביב', 'חיפה', 'ירושלים', 'באר שבע', 'נתניה', 'אשדוד', 'פתח תקווה', 'רחובות', 'הרצליה', 'כפר סבא'];
export const EN_CITIES = ['Austin', 'Denver', 'Miami', 'Seattle', 'Boston', 'Phoenix', 'Chicago', 'Atlanta', 'Portland', 'Dallas'];
export const HE_STREETS = ['הרצל', 'ויצמן', 'בן גוריון', 'רוטשילד', 'הנשיא', 'אלנבי', 'הגפן', 'הזית', 'דיזנגוף', 'סוקולוב'];
export const EN_STREETS = ['Oak Street', 'Maple Avenue', 'Main Street', 'Cedar Lane', 'Pine Road', 'Lake Drive', 'Hill Street', 'Park Avenue'];

export const HE_PRODUCTS = ['פטיש', 'מברגה', 'פלס', 'מסור', 'סרגל', 'פלייר', 'מקדח', 'סולם', 'מברג', 'אזמל', 'מפתח ברגים', 'מדחס'];
export const EN_PRODUCTS = ['Hammer', 'Drill', 'Level', 'Saw', 'Ruler', 'Pliers', 'Ladder', 'Wrench', 'Chisel', 'Compressor', 'Screwdriver', 'Clamp'];
export const HE_DEPARTMENTS = ['מכירות', 'רכש', 'כספים', 'לוגיסטיקה', 'שיווק', 'משאבי אנוש'];
export const EN_DEPARTMENTS = ['Sales', 'Procurement', 'Finance', 'Logistics', 'Marketing', 'HR'];
export const HE_COMPANIES = ['אלון ובניו', 'טכנו-פלוס', 'גרין אנרג׳י', 'מרום יבוא', 'שחר שיווק', 'נגב תעשיות'];
export const EN_COMPANIES = ['Acme Supply', 'Northwind Traders', 'Global Parts', 'Pinnacle Materials', 'Summit Logistics', 'Blue Harbor'];

export const HE_STATUS = ['פעיל', 'לא פעיל', 'ממתין', 'מבוטל'];
export const EN_STATUS = ['Active', 'Inactive', 'Pending', 'Cancelled'];

// ---------- Generators ----------

export function pickFirst(rng: Rng, lang: 'he' | 'en'): string {
  return pick(rng, lang === 'he' ? HE_FIRST : EN_FIRST);
}
export function pickLast(rng: Rng, lang: 'he' | 'en'): string {
  return pick(rng, lang === 'he' ? HE_LAST : EN_LAST);
}
export function pickCity(rng: Rng, lang: 'he' | 'en'): string {
  return pick(rng, lang === 'he' ? HE_CITIES : EN_CITIES);
}
export function pickProduct(rng: Rng, lang: 'he' | 'en'): string {
  return pick(rng, lang === 'he' ? HE_PRODUCTS : EN_PRODUCTS);
}
export function pickDepartment(rng: Rng, lang: 'he' | 'en'): string {
  return pick(rng, lang === 'he' ? HE_DEPARTMENTS : EN_DEPARTMENTS);
}
export function pickCompany(rng: Rng, lang: 'he' | 'en'): string {
  return pick(rng, lang === 'he' ? HE_COMPANIES : EN_COMPANIES);
}

/** Builds `g.n` rows from a per-row function (the common case for a generator). */
/** A pick from `pool`; in the "next" file, about a quarter of the picks come from `unseen` instead (values the example never showed). */
export function pickOrUnseen<T>(g: GenCtx, pool: readonly T[], unseen: readonly T[]): T {
  if (g.variant === 'next' && unseen.length > 0 && g.rng() < 0.25) return pick(g.rng, unseen);
  return pick(g.rng, pool);
}

export function rowsOf(g: GenCtx, fn: (i: number) => Row): Row[] {
  const out: Row[] = [];
  for (let i = 0; i < g.n; i++) out.push(fn(i));
  return out;
}

/** `prefix` + the number zero-padded to `width` digits ("INV-0007"). */
export function seqId(prefix: string, n: number, width: number): string {
  return `${prefix}${String(n).padStart(width, '0')}`;
}

/** A random string of `len` uppercase Latin letters. */
export function randLetters(rng: Rng, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(65 + randInt(rng, 0, 25));
  return s;
}

/** A random string of `len` digits (leading zeros allowed). */
export function randDigits(rng: Rng, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += String(randInt(rng, 0, 9));
  return s;
}

/** An amount in whole cents turned into a number with 2 decimals ("integer cents" keeps oracles exact). */
export function cents(c: number): number {
  return Math.round(c) / 100;
}

/** A random amount in [min, max] with 2 decimals. */
export function randMoney(rng: Rng, min: number, max: number): number {
  return cents(randInt(rng, Math.round(min * 100), Math.round(max * 100)));
}

// ---------- Rounding (half away from zero, like the engine's `round`; tolerant of float noise) ----------

export function roundTo(x: number, digits: number): number {
  const f = 10 ** digits;
  const y = Math.abs(x) * f;
  const r = Math.floor(y + 0.5 + 1e-9) / f;
  return x < 0 ? -r : r;
}

// ---------- Dates (independent of the engine's date code) ----------

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}
export function daysInMonth(y: number, m: number): number {
  return m === 2 && isLeap(y) ? 29 : (DAYS_IN_MONTH[m - 1] ?? 31);
}

/** A random date in [year0-01-01, year1-12-31]; `anyDay` false keeps the day within 1-28. */
export function randDate(rng: Rng, year0: number, year1: number, anyDay = false): Ymd {
  const y = randInt(rng, year0, year1);
  const m = randInt(rng, 1, 12);
  const d = randInt(rng, 1, anyDay ? daysInMonth(y, m) : 28);
  return { y, m, d };
}

function dayNumber(d: Ymd): number {
  return Math.round(Date.UTC(d.y, d.m - 1, d.d) / 86400000);
}
function fromDayNumber(n: number): Ymd {
  const dt = new Date(n * 86400000);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

export function addDays(d: Ymd, n: number): Ymd {
  return fromDayNumber(dayNumber(d) + n);
}
/** Adds months, clamping the day to the target month's last day (Excel EDATE). */
export function addMonths(d: Ymd, n: number): Ymd {
  const total = d.y * 12 + (d.m - 1) + n;
  const y = Math.floor(total / 12);
  const m = total - y * 12 + 1;
  return { y, m, d: Math.min(d.d, daysInMonth(y, m)) };
}
export function endOfMonthOf(d: Ymd): Ymd {
  return { y: d.y, m: d.m, d: daysInMonth(d.y, d.m) };
}
/** Whole days from a to b (negative when b is before a). */
export function daysBetween(a: Ymd, b: Ymd): number {
  return dayNumber(b) - dayNumber(a);
}
/** Complete months from a to b (a <= b). */
export function monthsBetween(a: Ymd, b: Ymd): number {
  let m = (b.y - a.y) * 12 + (b.m - a.m);
  if (b.d < a.d) m -= 1;
  return m;
}
/** Complete years from a to b (a <= b). */
export function yearsBetween(a: Ymd, b: Ymd): number {
  let y = b.y - a.y;
  if (b.m < a.m || (b.m === a.m && b.d < a.d)) y -= 1;
  return y;
}
export function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export const MONTHS_HE = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
export const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const WEEKDAYS_HE = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
export const WEEKDAYS_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** 0 = Sunday .. 6 = Saturday. */
export function weekdayOf(d: Ymd): number {
  return new Date(Date.UTC(d.y, d.m - 1, d.d)).getUTCDay();
}

export function isYmd(v: unknown): v is Ymd {
  return typeof v === 'object' && v !== null && 'y' in v && 'm' in v && 'd' in v;
}

// ---------- Number text (the oracle's own formatter: half away from zero on exact cents) ----------

/** `x` with `decimals` decimals and optional thousands separators ("1,234.50"). */
export function fmtNumber(x: number, decimals: number, thousands = true): string {
  const s = roundTo(Math.abs(x), decimals).toFixed(decimals);
  const [intPart = '', frac] = s.split('.');
  const grouped = thousands ? intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : intPart;
  return `${x < 0 && Number(s) !== 0 ? '-' : ''}${grouped}${frac !== undefined ? `.${frac}` : ''}`;
}
