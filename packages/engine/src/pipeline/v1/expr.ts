// Expression interpreter (SPEC 8.3). Expressions are a closed AST, compiled once
// into closures with column ids resolved to row slots. There is no string
// evaluation of any kind.

import Decimal from 'decimal.js';
import type { Expr, ExprNode } from '@formatai/shared';
import { formatYmd } from '../../values/dates';
import { excelRound } from '../../values/numbers';
import { padLeft } from '../../values/text';
import { InternalRulesError } from './rows';
import {
  DateVal,
  ZERO,
  compareVals,
  decInt,
  toDate,
  toNum,
  toText,
  truthy,
  type Val,
} from './values';

export const MAX_EXPR_DEPTH = 6;

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

export interface CompileEnv {
  slotOf: ReadonlyMap<string, number>;
  language: 'he' | 'en';
}

function constVal(c: string | number | boolean | null): Val {
  if (c === null) return null;
  if (typeof c === 'number') return Number.isFinite(c) ? new Decimal(c) : String(c);
  if (typeof c === 'string') return c === '' ? null : c;
  return c;
}

function depth(e: Expr): number {
  if ('col' in e || 'const' in e) return 1;
  let max = 0;
  for (const ch of children(e)) max = Math.max(max, depth(ch));
  return 1 + max;
}

function children(e: ExprNode): Expr[] {
  switch (e.op) {
    case 'if':
      return [e.cond, e.then, e.else];
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
      return e.args;
    default:
      return [e.arg];
  }
}

/** Compiles an expression. Throws InternalRulesError on an unknown column or excess depth. */
export function compileExpr(e: Expr, env: CompileEnv): Fn {
  if (depth(e) > MAX_EXPR_DEPTH) {
    throw new InternalRulesError(`expression deeper than ${MAX_EXPR_DEPTH}`);
  }
  return compile(e, env);
}

// DECISION: empty operands in arithmetic. Like Excel, an empty operand counts
// as 0 in add/sub/mul/div (so premium + empty bonus = premium, and empty ÷ n = 0),
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
