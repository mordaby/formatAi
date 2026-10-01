// The inverse of `./parseFormula.ts`: prints an `Expr` AST as formula TEXT (learn-v5).
// Mirrors `parseFormula.ts`'s grammar exactly - see that file's header comment for the
// grammar itself - so `parseFormula(printFormula(e))` always reproduces `e` (this is
// the exact-round-trip contract `formula/formulaRules.ts`'s property test relies on).
//
// Precedence/parenthesization: every `Expr` node falls into one of four "print classes"
// - compare (=, <>, <, >, <=, >=), sum (+, -), product (*, /), or atom (everything else:
// leaves, `neg`, and every function-call-form op, since a function call is lexically
// self-delimited by its own parens and never needs an extra pair). An atom child never
// needs parens. A sum/product/compare child needs parens exactly when doing without them
// would make `parseFormula` build a DIFFERENT tree: the LEADING operand of a chain only
// needs parens when its own class binds more loosely (lower rank) than the parent -
// `parseFormula`'s left-to-right "flatten while the running op stays the same" (see its
// `mergeInfix`) already reconstructs a same-or-tighter leading child with no parens - but
// every OTHER (non-leading) operand needs parens whenever its class is not strictly
// tighter (rank <= parent's rank), because a following same-or-looser operator would
// otherwise reattach to it instead of stopping at the parent.
import type { Expr, ExprConstValue, ExprNode } from '@formatai/shared';
import { OP_SIGNATURES } from '../check/signatures';

type PrecClass = 'compare' | 'sum' | 'product' | 'atom';

const RANK: Readonly<Record<PrecClass, number>> = { compare: 1, sum: 2, product: 3, atom: 4 };

function isExprNode(e: Expr): e is ExprNode {
  return 'op' in e;
}

function classOf(e: Expr): PrecClass {
  if (!isExprNode(e)) return 'atom';
  switch (e.op) {
    case 'eq':
    case 'ne':
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      return 'compare';
    case 'add':
    case 'sub':
      return 'sum';
    case 'mul':
    case 'div':
      return 'product';
    default:
      return 'atom'; // neg, and every function-call-form op (self-delimited by its parens)
  }
}

function printChild(e: Expr, parentClass: PrecClass, leading: boolean): string {
  const text = printExpr(e);
  const c = classOf(e);
  if (c === 'atom') return text;
  const needsParens = leading ? RANK[c] < RANK[parentClass] : RANK[c] <= RANK[parentClass];
  return needsParens ? `(${text})` : text;
}

function infixSymbol(op: 'add' | 'sub' | 'mul' | 'div' | 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte'): string {
  const form = OP_SIGNATURES[op].formula;
  if (form.form !== 'infix') throw new Error(`printFormula: op "${op}" is not infix`);
  return form.symbol;
}

function printStringLiteral(s: string): string {
  // Linear split/join, never a regex over untrusted-length input (this file only ever
  // runs on our OWN already-validated rules trees, but kept consistent with the
  // parser's own no-backtracking-regex discipline).
  const escaped = s.split('\\').join('\\\\').split('"').join('\\"');
  return `"${escaped}"`;
}

function printNumber(v: number): string {
  if (v < 0) return `-${printNonNegativeNumber(-v)}`;
  return printNonNegativeNumber(v);
}

function printNonNegativeNumber(v: number): string {
  const s = v.toString();
  if (s.includes('e') || s.includes('E')) {
    throw new Error(`printFormula: number ${v} would need exponential notation, which formula text doesn't support`);
  }
  return s;
}

function printConst(v: ExprConstValue): string {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return printNumber(v);
  return printStringLiteral(v);
}

function call1(fn: string, arg: Expr): string {
  return `${fn}(${printExpr(arg)})`;
}
function callN(fn: string, parts: readonly string[]): string {
  return `${fn}(${parts.join(', ')})`;
}

type InfixOp = 'add' | 'sub' | 'mul' | 'div' | 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte';

function printCall(e: Exclude<ExprNode, { op: InfixOp }>): string {
  switch (e.op) {
    case 'neg':
      return `-${printChild(e.arg, 'atom', false)}`;
    case 'abs':
      return call1('abs', e.arg);
    case 'floor':
      return call1('floor', e.arg);
    case 'ceil':
      return call1('ceil', e.arg);
    case 'mod':
      return callN('mod', [printExpr(e.args[0]), printExpr(e.args[1])]);
    case 'min':
      return callN('min', e.args.map(printExpr));
    case 'max':
      return callN('max', e.args.map(printExpr));
    case 'round':
      return callN('round', [printExpr(e.arg), String(e.digits)]);
    case 'concat':
      return callN('concat', e.args.map(printExpr));
    case 'substr':
      return callN('substr', [printExpr(e.arg), String(e.start), String(e.length)]);
    case 'trim':
      return call1('trim', e.arg);
    case 'upper':
      return call1('upper', e.arg);
    case 'lower':
      return call1('lower', e.arg);
    case 'length':
      return call1('length', e.arg);
    case 'replaceText':
      return callN('replaceText', [printExpr(e.arg), printStringLiteral(e.find), printStringLiteral(e.with)]);
    case 'padLeft':
      return callN('padLeft', [printExpr(e.arg), String(e.length), printStringLiteral(e.char)]);
    case 'split':
      return callN('split', [printExpr(e.arg), printStringLiteral(e.separator), String(e.index)]);
    case 'toNumber':
      return call1('toNumber', e.arg);
    case 'toText':
      return e.format === undefined ? callN('toText', [printExpr(e.arg)]) : callN('toText', [printExpr(e.arg), printStringLiteral(e.format)]);
    case 'datePart':
      return callN('datePart', [printExpr(e.arg), printStringLiteral(e.part)]);
    case 'dateFormat':
      return callN('dateFormat', [printExpr(e.arg), printStringLiteral(e.format)]);
    case 'dateAdd': {
      const days = e.days;
      const months = e.months;
      const amount = days !== undefined ? days : months !== undefined ? months : (e.years as number);
      const unit = days !== undefined ? 'days' : months !== undefined ? 'months' : 'years';
      return callN('dateAdd', [printExpr(e.arg), String(amount), printStringLiteral(unit)]);
    }
    case 'dateDiff':
      return callN('dateDiff', [printExpr(e.args[0]), printExpr(e.args[1]), printStringLiteral(e.unit)]);
    case 'endOfMonth':
      return call1('endOfMonth', e.arg);
    case 'weekday':
      return call1('weekday', e.arg);
    case 'makeDate':
      return callN('makeDate', e.args.map(printExpr));
    case 'toDate':
      return callN('toDate', [printExpr(e.arg), printStringLiteral(e.format)]);
    case 'dateLiteral':
      return callN('date', [printStringLiteral(e.value)]);
    case 'keepChars':
      return callN('keepChars', [printExpr(e.arg), printStringLiteral(e.chars)]);
    case 'titleCase':
      return call1('titleCase', e.arg);
    case 'find':
      return callN('find', [printExpr(e.arg), printStringLiteral(e.search)]);
    case 'if':
      return callN('if', [printExpr(e.cond), printExpr(e.then), printExpr(e.else)]);
    case 'switch': {
      const parts: string[] = [];
      for (const c of e.cases) {
        parts.push(printExpr(c.when), printExpr(c.then));
      }
      parts.push(printExpr(e.else));
      return callN('switch', parts);
    }
    case 'coalesce':
      return callN('coalesce', e.args.map(printExpr));
    case 'lookup': {
      const parts = [printStringLiteral(e.table), printExpr(e.key), printStringLiteral(e.return)];
      // The default (SPEC/LEARN_PROMPT: "Set onMissing to flag") is omitted from the
      // printed text; `parseFormula` fills it back in, so this round-trips exactly.
      if (e.onMissing !== 'flag') parts.push(printStringLiteral(e.onMissing));
      return callN('lookup', parts);
    }
    case 'call':
      return callN(e.fn, e.args.map(printExpr));
    case 'isEmpty':
      return call1('isEmpty', e.arg);
    case 'notEmpty':
      return call1('notEmpty', e.arg);
    case 'oneOf':
      return callN('oneOf', [printExpr(e.arg), ...e.values.map(printConst)]);
    case 'startsWith':
      return callN('startsWith', [printExpr(e.arg), printStringLiteral(e.text)]);
    case 'endsWith':
      return callN('endsWith', [printExpr(e.arg), printStringLiteral(e.text)]);
    case 'contains':
      return callN('contains', [printExpr(e.arg), printStringLiteral(e.text)]);
    case 'and':
      return callN('and', e.args.map(printExpr));
    case 'or':
      return callN('or', e.args.map(printExpr));
    case 'not':
      return call1('not', e.arg);
    default: {
      // add/sub/mul/div/eq/ne/gt/gte/lt/lte are infix, handled in printExpr directly.
      const never: never = e;
      throw new Error(`printFormula: unhandled op ${JSON.stringify(never)}`);
    }
  }
}

function printExpr(e: Expr): string {
  if ('col' in e) return e.col;
  if ('param' in e) return e.param;
  if ('const' in e) return printConst(e.const);

  switch (e.op) {
    case 'add':
    case 'sub':
    case 'mul': {
      const cls = classOf(e);
      const symbol = infixSymbol(e.op);
      return e.args.map((a, i) => printChild(a, cls, i === 0)).join(` ${symbol} `);
    }
    case 'div': {
      const cls = classOf(e);
      const symbol = infixSymbol(e.op);
      return e.args.map((a, i) => printChild(a, cls, i === 0)).join(` ${symbol} `);
    }
    case 'eq':
    case 'ne':
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const symbol = infixSymbol(e.op);
      return `${printChild(e.args[0], 'compare', true)} ${symbol} ${printChild(e.args[1], 'compare', false)}`;
    }
    default:
      return printCall(e);
  }
}

/**
 * Prints an `Expr` AST as formula text (learn-v5). The caller decides where the string
 * ends up (a computed column's `expr`, a function body, ...) - this function only
 * renders one expression tree.
 */
export function printFormula(expr: Expr): string {
  return printExpr(expr);
}
