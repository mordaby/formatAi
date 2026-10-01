// Expression interpreter (SPEC 8.3). Expressions are a closed AST, compiled once
// into closures with column ids resolved to row slots. There is no string
// evaluation of any kind.

import Decimal from 'decimal.js';
import { limits, type Expr, type ExprNode, type RulesFunction, type RulesTable } from '@formatai/shared';
import { compileDateParser, formatYmd, isValidYmd, parseDate, weekdayOfYmd, type Ymd } from '../../values/dates';
import { excelRound } from '../../values/numbers';
import { keepCharsOfClass, padLeft, titleCaseText } from '../../values/text';
import { formatNumberText, isDateFormat } from './layout';
import { InternalRulesError } from './rows';
import {
  DateVal,
  ZERO,
  compareVals,
  dateFromSerial,
  dateFromYmd,
  decInt,
  decText,
  normKey,
  toDate,
  toNum,
  toText,
  truthy,
  type Val,
} from './values';

// DECISION: this is the runtime mirror of checkRules's own depth check (both
// read the same config, SPEC non-negotiable #8): checkRules already rejects a
// rules file whose expression tree is too deep (SPEC 9.2 layer 1/2), so this
// is a defensive second check, not the primary one -- but it must use the same
// limit, or a rules file that passed checkRules (depth <= 8) could still throw
// here and surface as a generic "engine" error instead of running.
export const MAX_EXPR_DEPTH = limits.rules.maxExprDepth;

/**
 * Per-evaluation context. The caller sets `report` target fields before each
 * evaluation; an expression reports at most one problem per evaluation.
 */
export interface EvalCx {
  reported: boolean;
  /** messageKey of the first problem ("flag.expr.divByZero", ...). */
  problem: string | null;
  problemValue: Val;
}

export function newEvalCx(): EvalCx {
  return { reported: false, problem: null, problemValue: null };
}

export function resetCx(cx: EvalCx): void {
  cx.reported = false;
  cx.problem = null;
  cx.problemValue = null;
}

function report(cx: EvalCx, key: string, value: Val): void {
  if (cx.reported) return;
  cx.reported = true;
  cx.problem = key;
  cx.problemValue = value;
}

export type Fn = (r: readonly Val[], cx: EvalCx) => Val;

/**
 * A `transform.tables` table, compiled once (SPEC 8.14): its column names
 * resolved to row-array indices, and every row keyed by its first (key)
 * column, compared "after type normalization" (normalizeText of its text
 * form, the same rule as every other equality in the engine).
 */
export interface CompiledTable {
  columns: ReadonlyMap<string, number>;
  byKey: ReadonlyMap<string, Val[]>;
}

export interface CompileEnv {
  slotOf: ReadonlyMap<string, number>;
  language: 'he' | 'en';
  /**
   * `transform.functions`, compiled once and shared by every expression in the
   * rules file (row-level expressions and function bodies alike), so a `call`
   * anywhere can resolve any function. Absent in tests that compile a bare
   * expression with no functions declared.
   */
  functions?: ReadonlyMap<string, Fn>;
  /** `transform.tables`, compiled once and shared the same way, for `lookup`. */
  tables?: ReadonlyMap<string, CompiledTable>;
}

function constVal(c: string | number | boolean | null): Val {
  if (c === null) return null;
  if (typeof c === 'number') return Number.isFinite(c) ? new Decimal(c) : String(c);
  if (typeof c === 'string') return c === '' ? null : c;
  return c;
}

function depth(e: Expr): number {
  if ('col' in e || 'const' in e || 'param' in e) return 1;
  let max = 0;
  for (const ch of children(e)) max = Math.max(max, depth(ch));
  return 1 + max;
}

function children(e: ExprNode): Expr[] {
  switch (e.op) {
    case 'if':
      return [e.cond, e.then, e.else];
    case 'switch':
      return [...e.cases.flatMap((cs) => [cs.when, cs.then]), e.else];
    case 'lookup':
      return [e.key];
    case 'call':
      return e.args;
    case 'dateLiteral':
      return [];
    case 'add':
    case 'sub':
    case 'mul':
    case 'div':
    case 'concat':
    case 'coalesce':
    case 'and':
    case 'or':
    case 'eq':
    case 'ne':
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
    case 'min':
    case 'max':
    case 'mod':
    case 'dateDiff':
    case 'makeDate':
      return e.args;
    default:
      return [e.arg];
  }
}

// ---------- date helpers for dateAdd / dateDiff / endOfMonth (SPEC 8.3) ----------

/** Last valid day of a month (28-31), found via isValidYmd rather than
 * duplicating dates.ts's private daysInMonth table. */
function lastDayOfMonth(y: number, m: number): number {
  for (let d = 31; d >= 28; d--) {
    if (isValidYmd({ y, m, d })) return d;
  }
  return 28;
}

/**
 * Adds whole months to a calendar date, Excel EDATE-style: the day clamps to
 * the target month's last day when the original day doesn't exist there (e.g.
 * Jan 31 + 1 month -> Feb 28 or 29, never rolling over into March). `years` is
 * modeled as `months: years * 12` by the caller.
 */
function addMonthsClamped(ymd: Ymd, months: number): Ymd {
  const total = ymd.y * 12 + (ymd.m - 1) + months;
  const y = Math.floor(total / 12);
  const m = total - y * 12 + 1;
  return { y, m, d: Math.min(ymd.d, lastDayOfMonth(y, m)) };
}

/** Complete months from `a` to `b` (DATEDIF "M"), assuming b is on or after a. */
function completeMonths(a: Ymd, b: Ymd): number {
  let months = (b.y - a.y) * 12 + (b.m - a.m);
  if (b.d < a.d) months -= 1;
  return months;
}

/** Complete years from `a` to `b` (DATEDIF "Y"), assuming b is on or after a. */
function completeYears(a: Ymd, b: Ymd): number {
  let years = b.y - a.y;
  if (b.m < a.m || (b.m === a.m && b.d < a.d)) years -= 1;
  return years;
}

/** A date the new date ops may produce: a real calendar date in the 1900-9999 range (a year below
 * 1900 is never read as 1900 + year, which `Date.UTC` would do for 0-99). */
function strictDate(ymd: Ymd): DateVal | null {
  return ymd.y >= 1900 && ymd.y <= 9999 ? dateFromYmd(ymd) : null;
}

/** Compiles an expression. Throws InternalRulesError on an unknown column or excess depth. */
export function compileExpr(e: Expr, env: CompileEnv): Fn {
  if (depth(e) > MAX_EXPR_DEPTH) {
    throw new InternalRulesError(`expression deeper than ${MAX_EXPR_DEPTH}`);
  }
  return compile(e, env);
}

// DECISION: empty operands in arithmetic. Like Excel, an empty operand counts
// as 0 in add/sub/mul/div (so amount + empty surcharge = amount, and empty ÷ n = 0),
// except that when *every* operand is empty the result is empty. A divisor that
// is 0 or empty gives an empty result and a "flag.expr.divByZero" flag. Text
// that isn't a number gives an empty result and "flag.expr.notNumber".
// neg/abs/round of an empty value stay empty.
type Arith = 'add' | 'sub' | 'mul' | 'div';

function compileArith(op: Arith, args: Expr[], env: CompileEnv): Fn {
  const fs = args.map((a) => compile(a, env));
  const n = fs.length;
  // Per-node scratch: safe because evaluation is synchronous and a node never re-enters itself.
  const scratch: (Decimal | null)[] = new Array<Decimal | null>(n).fill(null);
  return (r, cx) => {
    let any = false;
    for (let i = 0; i < n; i++) {
      const v = (fs[i] as Fn)(r, cx);
      const d = toNum(v);
      if (d === undefined) {
        report(cx, 'flag.expr.notNumber', v);
        return null;
      }
      if (d !== null) any = true;
      scratch[i] = d;
    }
    if (!any) return null;
    let acc = scratch[0] ?? ZERO;
    for (let i = 1; i < n; i++) {
      const d = scratch[i] ?? ZERO;
      switch (op) {
        case 'add':
          acc = acc.plus(d);
          break;
        case 'sub':
          acc = acc.minus(d);
          break;
        case 'mul':
          acc = acc.times(d);
          break;
        case 'div':
          if (d.isZero()) {
            report(cx, 'flag.expr.divByZero', null);
            return null;
          }
          // decimal.js default precision (20 significant digits, half-up) — far
          // beyond Excel's 15 digits.
          acc = acc.div(d);
          break;
      }
    }
    return acc;
  };
}

function numUnary(f: Fn, g: (d: Decimal) => Decimal): Fn {
  return (r, cx) => {
    const v = f(r, cx);
    const d = toNum(v);
    if (d === undefined) {
      report(cx, 'flag.expr.notNumber', v);
      return null;
    }
    return d === null ? null : g(d);
  };
}

/** Text operation: empty stays empty; an empty-string result is empty. */
function textUnary(f: Fn, g: (s: string) => string): Fn {
  return (r, cx) => {
    const v = f(r, cx);
    if (v === null) return null;
    const out = g(toText(v));
    return out === '' ? null : out;
  };
}

function dateUnary(f: Fn, g: (d: DateVal) => Val): Fn {
  return (r, cx) => {
    const v = f(r, cx);
    const d = toDate(v);
    if (d === undefined) {
      report(cx, 'flag.expr.notDate', v);
      return null;
    }
    return d === null ? null : g(d);
  };
}

/**
 * Excel ROUND: half away from zero. For digits >= 0 this is exactly
 * excelRound's result, computed with one exact toDecimalPlaces instead of a
 * multiply/round/divide round trip (about 8x faster, and it can never lose
 * digits to decimal.js's working precision). Negative digits use excelRound.
 */
export function roundExcel(d: Decimal, digits: number): Decimal {
  return digits >= 0 ? d.toDecimalPlaces(digits, Decimal.ROUND_HALF_UP) : excelRound(d, digits);
}

// DECISION: substr `start` is 1-based like Excel's MID (start 1 = first
// character). A negative start counts from the end (-3 = the last 3
// characters, used for "last N characters"); 0 is treated as 1. Characters
// are Unicode code points. A length <= 0 or a start past the end gives empty.
export function substrCodePoints(s: string, start: number, length: number): string {
  if (length <= 0) return '';
  const cps = Array.from(s);
  let from: number;
  if (start > 0) from = start - 1;
  else if (start < 0) from = Math.max(0, cps.length + start);
  else from = 0;
  if (from >= cps.length) return '';
  return cps.slice(from, from + length).join('');
}

function compile(e: Expr, env: CompileEnv): Fn {
  if ('col' in e) {
    const slot = env.slotOf.get(e.col);
    if (slot === undefined) throw new InternalRulesError(`unknown column id "${e.col}"`);
    return (r) => r[slot] ?? null;
  }
  if ('const' in e) {
    const c = constVal(e.const);
    return () => c;
  }
  if ('param' in e) {
    // A function body's leaves (SPEC 8.14): the function's own "row" is the
    // call's argument values, so `param` resolves through `env.slotOf` exactly
    // like `col` resolves a row, just built from a different name->index map
    // (see compileFunctions).
    const slot = env.slotOf.get(e.param);
    if (slot === undefined) throw new InternalRulesError(`unknown param "${e.param}"`);
    return (r) => r[slot] ?? null;
  }
  const c = (x: Expr): Fn => compile(x, env);
  switch (e.op) {
    case 'add':
    case 'sub':
    case 'mul':
    case 'div':
      return compileArith(e.op, e.args, env);
    case 'neg':
      return numUnary(c(e.arg), (d) => d.neg());
    case 'abs':
      return numUnary(c(e.arg), (d) => d.abs());
    case 'floor':
      return numUnary(c(e.arg), (d) => d.floor());
    case 'ceil':
      return numUnary(c(e.arg), (d) => d.ceil());
    // DECISION: mod follows Excel MOD's sign rule (result takes the divisor's
    // sign: n - d*FLOOR(n/d)). Empty operands follow the same "empty counts as
    // 0" rule as add/sub/mul/div; a zero (or empty) divisor gives empty and
    // reports "flag.expr.divByZero" (the same key as `div`: it's the same
    // failure, just reached through `mod`).
    case 'mod': {
      const [af, bf] = e.args.map(c) as [Fn, Fn];
      return (r, cx) => {
        const xv = af(r, cx);
        const x = toNum(xv);
        if (x === undefined) {
          report(cx, 'flag.expr.notNumber', xv);
          return null;
        }
        const yv = bf(r, cx);
        const y = toNum(yv);
        if (y === undefined) {
          report(cx, 'flag.expr.notNumber', yv);
          return null;
        }
        if (x === null && y === null) return null;
        const yy = y ?? ZERO;
        if (yy.isZero()) {
          report(cx, 'flag.expr.divByZero', null);
          return null;
        }
        const xx = x ?? ZERO;
        return xx.minus(yy.times(xx.div(yy).floor()));
      };
    }
    // min/max ignore empty operands; all-empty gives empty (like add/sub/mul).
    case 'min':
    case 'max': {
      const fs = e.args.map(c);
      const pick = e.op === 'min' ? (a: Decimal, b: Decimal) => (b.lt(a) ? b : a) : (a: Decimal, b: Decimal) => (b.gt(a) ? b : a);
      return (r, cx) => {
        let best: Decimal | null = null;
        for (const f of fs) {
          const v = f(r, cx);
          const d = toNum(v);
          if (d === undefined) {
            report(cx, 'flag.expr.notNumber', v);
            return null;
          }
          if (d === null) continue;
          best = best === null ? d : pick(best, d);
        }
        return best;
      };
    }
    case 'round': {
      const digits = e.digits;
      return numUnary(c(e.arg), (d) => roundExcel(d, digits));
    }

    case 'concat': {
      const fs = e.args.map(c);
      return (r, cx) => {
        let out = '';
        for (const f of fs) out += toText(f(r, cx));
        return out === '' ? null : out;
      };
    }
    case 'substr': {
      const { start, length } = e;
      return textUnary(c(e.arg), (s) => substrCodePoints(s, start, length));
    }
    case 'trim':
      // Like Excel TRIM: strip the ends and collapse inner runs of whitespace.
      return textUnary(c(e.arg), (s) => s.trim().replace(/\s+/g, ' '));
    case 'upper':
      return textUnary(c(e.arg), (s) => s.toUpperCase());
    case 'lower':
      return textUnary(c(e.arg), (s) => s.toLowerCase());
    case 'replaceText': {
      const find = e.find;
      const repl = e.with;
      // Literal text only: split/join, never a regex.
      return textUnary(c(e.arg), (s) => (find === '' ? s : s.split(find).join(repl)));
    }
    case 'padLeft': {
      const { length, char } = e;
      return textUnary(c(e.arg), (s) => padLeft(s, length, char));
    }
    case 'length': {
      const f = c(e.arg);
      return (r, cx) => {
        const v = f(r, cx);
        return v === null ? null : decInt(Array.from(toText(v)).length);
      };
    }
    // DECISION: split's index is 1-based (SPEC 8.3); a negative index counts
    // from the end (-1 = the last part). An index of 0 never occurs (the
    // schema rejects it). Out of range (either direction) gives empty, like
    // every other "part not found" case in the engine.
    case 'split': {
      const { separator, index } = e;
      const f = c(e.arg);
      return (r, cx) => {
        const v = f(r, cx);
        if (v === null) return null;
        const parts = toText(v).split(separator);
        const i = index > 0 ? index - 1 : parts.length + index;
        if (i < 0 || i >= parts.length) return null;
        const p = parts[i] as string;
        return p === '' ? null : p;
      };
    }
    case 'toNumber': {
      const f = c(e.arg);
      return (r, cx) => {
        const v = f(r, cx);
        if (v === null) return null;
        const n = toNum(v);
        if (n === undefined) {
          report(cx, 'flag.expr.notNumber', v);
          return null;
        }
        return n;
      };
    }
    // toText with no format: plain text (toText). With a format: a date format
    // (via formatYmd, same token/Excel-style rules as dateFormat/output column
    // formats) when the format looks like a date format, else a number format
    // (formatNumberText, the same renderer title-row aggregates use).
    case 'toText': {
      const f = c(e.arg);
      const format = e.format;
      const lang = env.language;
      return (r, cx) => {
        const v = f(r, cx);
        if (v === null) return null;
        if (format === undefined) {
          const s = toText(v);
          return s === '' ? null : s;
        }
        if (isDateFormat(format, lang)) {
          const d = toDate(v);
          if (d === undefined) {
            report(cx, 'flag.expr.notDate', v);
            return null;
          }
          if (d === null) return null;
          const s = formatYmd(d, format, lang);
          return s === '' ? null : s;
        }
        const n = toNum(v);
        if (n === undefined) {
          report(cx, 'flag.expr.notNumber', v);
          return null;
        }
        if (n === null) return null;
        const s = formatNumberText(n, format);
        return s === '' ? null : s;
      };
    }

    case 'datePart': {
      const part = e.part;
      return dateUnary(c(e.arg), (d) => decInt(part === 'year' ? d.y : part === 'month' ? d.m : d.d));
    }
    case 'dateFormat': {
      const format = e.format;
      const lang = env.language;
      return dateUnary(c(e.arg), (d) => {
        const s = formatYmd(d, format, lang);
        return s === '' ? null : s;
      });
    }
    case 'dateAdd': {
      const f = c(e.arg);
      // Exactly one of days/months/years is set (the schema enforces it); each
      // variant declares the other two as `?: never`, so plain property access
      // (rather than `'days' in e`) gives a clean `number | undefined` here.
      const days = e.days;
      const months = e.months;
      const years = e.years;
      if (days !== undefined) {
        return dateUnary(f, (d) => dateFromSerial(d.serial + days, false));
      }
      const totalMonths = months !== undefined ? months : (years as number) * 12;
      return dateUnary(f, (d) => dateFromYmd(addMonthsClamped(d, totalMonths)));
    }
    // DECISION: DATEDIF requires start <= end and errors otherwise; the engine
    // never errors, so a negative span (args[1] before args[0]) is defined as
    // the negation of the same "complete months/years" measured the other way
    // round (dateDiff(b, a, unit) === -dateDiff(a, b, unit) for any a, b).
    case 'dateDiff': {
      const [af, bf] = e.args.map(c) as [Fn, Fn];
      const unit = e.unit;
      return (r, cx) => {
        const araw = af(r, cx);
        const av = toDate(araw);
        if (av === undefined) {
          report(cx, 'flag.expr.notDate', araw);
          return null;
        }
        const braw = bf(r, cx);
        const bv = toDate(braw);
        if (bv === undefined) {
          report(cx, 'flag.expr.notDate', braw);
          return null;
        }
        if (av === null || bv === null) return null;
        if (unit === 'days') return decInt(bv.serial - av.serial);
        if (av.serial === bv.serial) return decInt(0);
        const neg = bv.serial < av.serial;
        const start = neg ? bv : av;
        const end = neg ? av : bv;
        const n = unit === 'months' ? completeMonths(start, end) : completeYears(start, end);
        return decInt(neg ? -n : n);
      };
    }
    case 'endOfMonth': {
      return dateUnary(c(e.arg), (d) => dateFromYmd({ y: d.y, m: d.m, d: lastDayOfMonth(d.y, d.m) }));
    }

    // ---- added after learn-v6: weekday, makeDate, toDate, dateLiteral, keepChars, titleCase, find ----
    // DECISION: weekday is 1 = Sunday ... 7 = Saturday (weekdayOfYmd); an empty date gives empty.
    case 'weekday':
      return dateUnary(c(e.arg), (d) => decInt(weekdayOfYmd(d)));
    // DECISION: makeDate(year, month, day). Any empty part gives empty, no flag (like every
    // date op on an empty date). A part that isn't a number flags "notNumber"; whole numbers
    // that don't make a real date between 1900-01-01 and 9999-12-31 (month 13, 31 February,
    // a 2-digit year, a fraction) give empty and flag "notDate" with the parts as the value.
    case 'makeDate': {
      const fs = e.args.map(c);
      return (r, cx) => {
        const parts: Decimal[] = [];
        let anyEmpty = false;
        for (const f of fs) {
          const v = f(r, cx);
          const n = toNum(v);
          if (n === undefined) {
            report(cx, 'flag.expr.notNumber', v);
            return null;
          }
          if (n === null) anyEmpty = true;
          else parts.push(n);
        }
        if (anyEmpty) return null;
        const [y, m, d] = parts as [Decimal, Decimal, Decimal];
        const d0 = y.isInteger() && m.isInteger() && d.isInteger() ? strictDate({ y: y.toNumber(), m: m.toNumber(), d: d.toNumber() }) : null;
        if (d0 === null) {
          report(cx, 'flag.expr.notDate', `${decText(y)}-${decText(m)}-${decText(d)}`);
          return null;
        }
        return d0;
      };
    }
    // DECISION: toDate reads the text with `format` (the inputFormats tokens + MMMM/MMM month
    // names in Hebrew or English); no match, an unknown month name or an impossible date gives
    // empty and flags "notDate" with the text as the value. A value that is already a date is
    // returned as it is; a number is read as its plain text (20260131 with "YYYYMMDD").
    case 'toDate': {
      const f = c(e.arg);
      const parse = compileDateParser(e.format);
      return (r, cx) => {
        const v = f(r, cx);
        if (v === null) return null;
        if (v instanceof DateVal) return v;
        const ymd = parse(toText(v));
        const d = ymd === null ? null : strictDate(ymd);
        if (d === null) {
          report(cx, 'flag.expr.notDate', v);
          return null;
        }
        return d;
      };
    }
    // A fixed date. The schema and the formula parser only let a real YYYY-MM-DD through; a
    // hand-written JSON tree that slips past is empty and flagged on every row instead of
    // throwing at run time.
    case 'dateLiteral': {
      const ymd = parseDate(e.value, ['YYYY-MM-DD']);
      const d = ymd === null ? null : strictDate(ymd);
      const bad = e.value;
      return d === null
        ? (_r, cx) => {
            report(cx, 'flag.expr.notDate', bad);
            return null;
          }
        : () => d;
    }
    case 'keepChars': {
      const cls = e.chars;
      return textUnary(c(e.arg), (s) => keepCharsOfClass(s, cls));
    }
    case 'titleCase':
      return textUnary(c(e.arg), titleCaseText);
    // DECISION: find is 1-based in characters (code points, like substr/length), 0 when the
    // literal text is absent, case-sensitive; an empty value stays empty (like length).
    case 'find': {
      const search = e.search;
      const f = c(e.arg);
      return (r, cx) => {
        const v = f(r, cx);
        if (v === null) return null;
        const s = toText(v);
        const i = s.indexOf(search);
        return decInt(i < 0 ? 0 : Array.from(s.slice(0, i)).length + 1);
      };
    }

    case 'switch': {
      const cases = e.cases.map((cs) => ({ when: c(cs.when), then: c(cs.then) }));
      const els = c(e.else);
      return (r, cx) => {
        for (const cs of cases) {
          if (truthy(cs.when(r, cx))) return cs.then(r, cx);
        }
        return els(r, cx);
      };
    }
    // DECISION: the lookup key is compared "after type normalization" the same
    // way every other equality in the engine works: normalizeText of the
    // value's text form (see CompiledTable.byKey / compileTables). An empty
    // key gives empty, with no flag, regardless of onMissing.
    case 'lookup': {
      const table = env.tables?.get(e.table);
      if (table === undefined) throw new InternalRulesError(`unknown table "${e.table}"`);
      const returnIdx = table.columns.get(e.return);
      if (returnIdx === undefined) throw new InternalRulesError(`unknown table column "${e.return}"`);
      const keyFn = c(e.key);
      const onMissing = e.onMissing;
      return (r, cx) => {
        const kv = keyFn(r, cx);
        if (kv === null) return null;
        const row = table.byKey.get(normKey(kv));
        if (row === undefined) {
          if (onMissing === 'flag') {
            report(cx, 'flag.lookupMissing', kv);
            return null;
          }
          return onMissing === 'keep' ? kv : null;
        }
        return row[returnIdx] ?? null;
      };
    }
    // A function's params see only the values passed at this call site (SPEC
    // 8.14): `target` is the function's own body, already compiled against its
    // own param slots (compileFunctions), so it runs here exactly like a
    // top-level expression runs against a row.
    case 'call': {
      const target = env.functions?.get(e.fn);
      if (target === undefined) throw new InternalRulesError(`unknown function "${e.fn}"`);
      const argFns = e.args.map(c);
      return (r, cx) => target(argFns.map((f) => f(r, cx)), cx);
    }

    case 'if': {
      const cond = c(e.cond);
      const th = c(e.then);
      const el = c(e.else);
      // Only the chosen branch is evaluated (so it alone can raise a flag).
      return (r, cx) => (truthy(cond(r, cx)) ? th(r, cx) : el(r, cx));
    }
    case 'coalesce': {
      const fs = e.args.map(c);
      return (r, cx) => {
        for (const f of fs) {
          const v = f(r, cx);
          if (v !== null) return v;
        }
        return null;
      };
    }

    // DECISION: comparisons are typed like filters (numbers numerically, dates by
    // date, text by normalizeText then code point). Empty equals only empty;
    // gt/gte/lt/lte with an empty side are false.
    case 'eq':
    case 'ne': {
      const [a, b] = e.args.map(c) as [Fn, Fn];
      const want = e.op === 'eq';
      return (r, cx) => {
        const x = a(r, cx);
        const y = b(r, cx);
        const eq = x === null || y === null ? x === y : compareVals(x, y) === 0;
        return eq === want;
      };
    }
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const [a, b] = e.args.map(c) as [Fn, Fn];
      const op = e.op;
      return (r, cx) => {
        const k = compareVals(a(r, cx), b(r, cx));
        if (k === null) return false;
        return op === 'gt' ? k > 0 : op === 'gte' ? k >= 0 : op === 'lt' ? k < 0 : k <= 0;
      };
    }
    case 'isEmpty': {
      const f = c(e.arg);
      return (r, cx) => f(r, cx) === null;
    }
    case 'notEmpty': {
      const f = c(e.arg);
      return (r, cx) => f(r, cx) !== null;
    }
    // oneOf compares like eq (typed: numbers numerically, dates by date, text
    // by normalizeText), against each listed constant in turn.
    case 'oneOf': {
      const f = c(e.arg);
      const vals = e.values.map(constVal);
      return (r, cx) => {
        const v = f(r, cx);
        for (const cv of vals) {
          const eq = v === null || cv === null ? v === cv : compareVals(v, cv) === 0;
          if (eq) return true;
        }
        return false;
      };
    }
    // startsWith/endsWith/contains: literal text only (no regex), like
    // replaceText. An empty value is never a match.
    case 'startsWith':
    case 'endsWith':
    case 'contains': {
      const f = c(e.arg);
      const text = e.text;
      const op = e.op;
      return (r, cx) => {
        const v = f(r, cx);
        if (v === null) return false;
        const s = toText(v);
        return op === 'startsWith' ? s.startsWith(text) : op === 'endsWith' ? s.endsWith(text) : s.includes(text);
      };
    }
    case 'and': {
      const fs = e.args.map(c);
      return (r, cx) => {
        for (const f of fs) if (!truthy(f(r, cx))) return false;
        return true;
      };
    }
    case 'or': {
      const fs = e.args.map(c);
      return (r, cx) => {
        for (const f of fs) if (truthy(f(r, cx))) return true;
        return false;
      };
    }
    case 'not': {
      const f = c(e.arg);
      return (r, cx) => !truthy(f(r, cx));
    }
    default: {
      const never: never = e;
      throw new InternalRulesError(`unknown expression op ${JSON.stringify(never)}`);
    }
  }
}

// ---------- transform.tables / transform.functions (SPEC 8.14) ----------

/**
 * Compiles every `transform.tables` entry once per run. A table's first
 * column is its key (checked upstream for uniqueness); every other cell is
 * converted the same way an expression constant is (`constVal`), so a table
 * number reads as an exact Decimal, not a JS float.
 */
export function compileTables(tables: RulesTable[] | undefined): Map<string, CompiledTable> {
  const out = new Map<string, CompiledTable>();
  if (tables === undefined) return out;
  for (const t of tables) {
    const columns = new Map<string, number>();
    t.columns.forEach((name, i) => columns.set(name, i));
    const byKey = new Map<string, Val[]>();
    for (const raw of t.rows) {
      const vals = raw.map(constVal);
      const key = normKey(vals[0] ?? null);
      // Table keys must be unique (checked upstream); first occurrence wins,
      // deterministically, if that check is ever bypassed.
      if (!byKey.has(key)) byKey.set(key, vals);
    }
    out.set(t.name, { columns, byKey });
  }
  return out;
}

/**
 * Compiles `transform.functions` in declaration order (SPEC 8.14: a function
 * may call only functions defined above it), so `call` on function N only
 * ever resolves against functions 0..N-1 in `out`, making the call graph
 * acyclic by construction. A function body compiles exactly like any other
 * expression, except its leaves are `param` (never `col`): its "row" at call
 * time is the argument values, in the function's own declared param order.
 */
export function compileFunctions(
  functions: RulesFunction[] | undefined,
  base: { language: 'he' | 'en' },
  tables: ReadonlyMap<string, CompiledTable>,
): Map<string, Fn> {
  const out = new Map<string, Fn>();
  if (functions === undefined) return out;
  for (const f of functions) {
    const paramSlotOf = new Map<string, number>();
    f.params.forEach((p, i) => paramSlotOf.set(p.name, i));
    const env: CompileEnv = { slotOf: paramSlotOf, language: base.language, functions: out, tables };
    out.set(f.name, compileExpr(f.body, env));
  }
  return out;
}
