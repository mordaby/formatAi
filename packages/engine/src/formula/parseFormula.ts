// The formula grammar (learn-v5, SPEC 8.3/LEARN_PROMPT §2): the LLM writes every
// expression as TEXT (e.g. `round(amount * 0.17, 2)`) instead of a JSON tree. This file
// turns that text into exactly the same whitelisted `Expr` AST `schema.ts` already
// describes - nothing here is ever `eval`'d or otherwise executed; an unrecognized
// function or identifier is always a parse ERROR, never a fallback guess.
//
// Grammar (EBNF-ish; `NUMBER`/`STRING`/`IDENT` are lexer tokens - see `./lexer.ts`):
//
//   formula      := expression EOF
//   expression   := comparison
//   comparison   := sum ( ('=' | '<>' | '<' | '>' | '<=' | '>=') sum )?   -- not chainable
//   sum          := product ( ('+' | '-') product )*
//   product      := unary ( ('*' | '/') unary )*
//   unary        := '-' unary | primary
//   primary      := NUMBER | STRING | 'true' | 'false' | 'null'
//                 | IDENT ( '(' ( expression (',' expression)* )? ')' )?
//                 | '(' expression ')'
//
// - A bare NUMBER is always non-negative; a leading '-' is unary minus (see below).
// - A bare IDENT (not followed by '(') is a column id (`{col}`), or - only while
//   parsing a `transform.functions[].body` (`ctx.params` given) - a function param
//   (`{param}`), matching SPEC 8.14 ("a function sees only what it is given ... never
//   col"). Every other identifier position is a normal column id; the parser doesn't
//   know the rules file's actual column ids, so it can't reject an unknown one itself -
//   that's `checkRules`' job (SPEC 9.2 layer 2), same as today.
// - `-<NUMBER>` (unary minus directly on a number literal) folds into a single negative
//   `{const}` leaf, never a `neg` node - `printFormula.ts` mirrors this exactly, so
//   round-tripping a stored `{const: -5}` always reprints as "-5", never "neg(5)".
//   Unary minus on anything else (`-amount`, `-(a+b)`, `-f(x)`) produces a `neg` node.
// - `+ - * /` and the six comparisons are the ONLY infix operators; every other op is a
//   function call `fn(arg1, arg2, ...)` with a FIXED positional parameter order, defined
//   once in `../check/signatures.ts`'s `OP_SIGNATURES[op].formula` and consumed
//   identically here and in `./printFormula.ts`. A call to a name that ISN'T one of
//   those built-ins becomes `{op:"call", fn, args}` (SPEC 8.14's `transform.functions`) -
//   never an error at parse time; an undeclared function name is caught later by
//   `checkRules` (SPEC 9.2 layer 2), which has the actual rules file to check it against.
// - `switch(cond1, value1, cond2, value2, ..., elseValue)` and comparisons are the two
//   hand-written irregular shapes; everything else (`OP_SIGNATURES[op].formula.form ===
//   'call'`) is assembled generically from its declared `params` list.
//
// Security (untrusted LLM/editor input): `parseFormula` rejects text longer than
// `limits.rules.maxFormulaChars` before tokenizing at all (O(1), so a huge adversarial
// string never reaches the lexer); the parser also caps its own recursion depth
// (parens/call nesting) at `maxExprDepth` plus a small margin, failing with a normal
// parse error instead of a stack overflow. The tokenizer (`./lexer.ts`) is a single
// linear scan with no backtracking regular expressions. No identifier or function name
// from the input is ever used to index a plain JS object - only `Map`/`Array.includes`
// lookups - so `__proto__`/`constructor`/`toString` used as a column id, function name
// or table name behave as ordinary (if unusual) strings, nothing more.
import { limits, type Expr, type ExprConstValue, type ExprNode } from '@formatai/shared';
import { OP_SIGNATURES, type FormulaParam, type SigOp } from '../check/signatures';
import { LexError, tokenize, type Token, type TokenType } from './lexer';

export interface FormulaParseError {
  message: string;
  offset: number;
}

export type FormulaParseResult = { ok: true; expr: Expr } | { ok: false; error: FormulaParseError };

export interface FormulaParseContext {
  /** Present exactly when parsing a `transform.functions[].body` (SPEC 8.14). */
  params?: readonly string[];
}

class FormulaSyntaxError extends Error {
  offset: number;
  constructor(message: string, offset: number) {
    super(message);
    this.offset = offset;
  }
}

function fail(message: string, offset: number): never {
  throw new FormulaSyntaxError(message, offset);
}

// ---------- Safe (Map-based, never a plain-object index by untrusted text) call-form lookup ----------

interface CallFormEntry {
  op: SigOp;
  fn: string;
  params: readonly FormulaParam[];
}

const CALL_FORMS: ReadonlyMap<string, CallFormEntry> = (() => {
  const m = new Map<string, CallFormEntry>();
  for (const op of Object.keys(OP_SIGNATURES) as SigOp[]) {
    const sig = OP_SIGNATURES[op];
    if (sig.formula.form === 'call') {
      m.set(sig.formula.fn, { op, fn: sig.formula.fn, params: sig.formula.params });
    }
  }
  return m;
})();

const MAX_PARSE_DEPTH = limits.rules.maxExprDepth + 4;

function isExprNode(e: Expr): e is ExprNode {
  return 'op' in e;
}

interface ParsedArg {
  expr: Expr;
  offset: number;
}

// ---------- Recursive-descent parser ----------

class Parser {
  private readonly tokens: readonly Token[];
  private pos = 0;
  private primaryDepth = 0;
  private readonly ctx: FormulaParseContext;

  constructor(tokens: readonly Token[], ctx: FormulaParseContext) {
    this.tokens = tokens;
    this.ctx = ctx;
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private advance(): Token {
    const t = this.tokens[this.pos] as Token;
    if (this.pos < this.tokens.length - 1) this.pos++;
    return t;
  }

  private check(type: TokenType): boolean {
    return this.peek().type === type;
  }

  private expect(type: TokenType, what: string): Token {
    const t = this.peek();
    if (t.type !== type) fail(`expected ${what} at ${t.offset}`, t.offset);
    return this.advance();
  }

  parseTop(): Expr {
    const e = this.parseExpression();
    const t = this.peek();
    if (t.type !== 'eof') fail(`unexpected token "${t.text}" at ${t.offset}`, t.offset);
    return e;
  }

  private parseExpression(): Expr {
    return this.parseComparison();
  }

  private parseComparison(): Expr {
    const left = this.parseSum();
    const t = this.peek();
    const op: SigOp | undefined =
      t.type === '=' ? 'eq' : t.type === '<>' ? 'ne' : t.type === '<' ? 'lt' : t.type === '>' ? 'gt' : t.type === '<=' ? 'lte' : t.type === '>=' ? 'gte' : undefined;
    if (!op) return left;
    this.advance();
    const right = this.parseSum();
    return { op, args: [left, right] } as Expr;
  }

  private parseSum(): Expr {
    let current = this.parseProduct();
    for (;;) {
      const t = this.peek();
      if (t.type !== '+' && t.type !== '-') return current;
      this.advance();
      current = this.mergeInfix(t.type === '+' ? 'add' : 'sub', current, this.parseProduct());
    }
  }

  private parseProduct(): Expr {
    let current = this.parseUnary();
    for (;;) {
      const t = this.peek();
      if (t.type !== '*' && t.type !== '/') return current;
      this.advance();
      current = this.mergeInfix(t.type === '*' ? 'mul' : 'div', current, this.parseUnary());
    }
  }

  /** Left-assoc "flatten while the running op stays the same" (see this file's header
   * doc comment): extends `current`'s own `args` when it's already the same op, else
   * wraps both sides as a fresh 2-arg node. `printFormula.ts` mirrors this exactly. */
  private mergeInfix(op: 'add' | 'sub' | 'mul' | 'div', current: Expr, rhs: Expr): Expr {
    if (isExprNode(current) && current.op === op) {
      const args = (current as Extract<ExprNode, { op: 'add' | 'sub' | 'mul' | 'div' }>).args;
      return { op, args: [...args, rhs] } as Expr;
    }
    return { op, args: [current, rhs] } as Expr;
  }

  private parseUnary(): Expr {
    const t = this.peek();
    if (t.type === '-') {
      this.advance();
      const next = this.peek();
      if (next.type === 'number') {
        this.advance();
        return { const: -parseNumberLiteral(next.text, next.offset) };
      }
      return { op: 'neg', arg: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Expr {
    this.primaryDepth++;
    if (this.primaryDepth > MAX_PARSE_DEPTH) {
      const t = this.peek();
      fail(`expression nested too deeply (max ${MAX_PARSE_DEPTH}) at ${t.offset}`, t.offset);
    }
    try {
      const t = this.peek();
      if (t.type === 'number') {
        this.advance();
        return { const: parseNumberLiteral(t.text, t.offset) };
      }
      if (t.type === 'string') {
        this.advance();
        return { const: t.text };
      }
      if (t.type === '(') {
        this.advance();
        const inner = this.parseExpression();
        this.expect(')', '")"');
        return inner;
      }
      if (t.type === 'ident') {
        return this.parseIdentOrCall(t);
      }
      fail(`unexpected token "${t.text || 'end of formula'}" at ${t.offset}`, t.offset);
    } finally {
      this.primaryDepth--;
    }
  }

  private parseIdentOrCall(t: Token): Expr {
    this.advance();
    const name = t.text;

    if (!this.check('(')) {
      if (name === 'true') return { const: true };
      if (name === 'false') return { const: false };
      if (name === 'null') return { const: null };
      if (this.ctx.params) {
        if (!this.ctx.params.includes(name)) {
          fail(`unknown identifier "${name}" inside a function body at ${t.offset}`, t.offset);
        }
        return { param: name };
      }
      return { col: name };
    }

    this.advance(); // '('
    const args: ParsedArg[] = [];
    if (!this.check(')')) {
      for (;;) {
        const argOffset = this.peek().offset;
        args.push({ expr: this.parseExpression(), offset: argOffset });
        if (this.check(',')) {
          this.advance();
          continue;
        }
        break;
      }
    }
    this.expect(')', '")"');

    if (name === 'switch') return assembleSwitch(args, t.offset);

    const form = CALL_FORMS.get(name);
    if (!form) {
      // Not a built-in op: a call to a `transform.functions` entry (SPEC 8.14).
      // Validated against the rules file's actual functions later (checkRules).
      return { op: 'call', fn: name, args: args.map((a) => a.expr) };
    }
    return assembleCall(form, args, t.offset);
  }
}

function parseNumberLiteral(text: string, offset: number): number {
  const n = Number(text);
  if (!Number.isFinite(n)) fail(`invalid number "${text}" at ${offset}`, offset);
  return n;
}

// ---------- Generic call-form assembly (drives off OP_SIGNATURES[op].formula.params) ----------

function countRequired(params: readonly FormulaParam[]): number {
  let n = 0;
  for (const p of params) {
    if (p.kind === 'exprRest' || p.kind === 'constRest') n += p.min ?? 0;
    else if (!p.optional) n += 1;
  }
  return n;
}

function expectConst(fn: string, name: string, a: ParsedArg): ExprConstValue {
  if ('const' in a.expr) return a.expr.const;
  fail(`${fn}()'s "${name}" must be a fixed value, not an expression`, a.offset);
}

function coerceParam(fn: string, p: FormulaParam, a: ParsedArg): unknown {
  if (p.kind === 'expr') return a.expr;
  if (p.kind === 'int') {
    const v = expectConst(fn, p.name, a);
    if (typeof v !== 'number' || !Number.isInteger(v)) {
      fail(`${fn}()'s "${p.name}" must be a fixed whole number, not an expression`, a.offset);
    }
    return v;
  }
  if (p.kind === 'char') {
    const v = expectConst(fn, p.name, a);
    if (typeof v !== 'string' || v.length !== 1) {
      fail(`${fn}()'s "${p.name}" must be a single character in quotes`, a.offset);
    }
    return v;
  }
  if (p.kind === 'string') {
    const v = expectConst(fn, p.name, a);
    if (typeof v !== 'string') {
      fail(`${fn}()'s "${p.name}" must be a fixed piece of text in quotes, not an expression`, a.offset);
    }
    return v;
  }
  if (p.kind === 'exprRest' || p.kind === 'constRest') {
    // Unreachable: assembleCall always handles exprRest/constRest itself (they're only
    // ever the LAST param), never calling coerceParam for them.
    throw new Error(`formula: "${p.kind}" param "${p.name}" reached coerceParam`);
  }
  // { enum: [...] }
  const values = p.kind.enum;
  const v = expectConst(fn, p.name, a);
  if (typeof v !== 'string' || !values.includes(v)) {
    fail(`${fn}()'s "${p.name}" must be one of: ${values.map((x: string) => `"${x}"`).join(', ')}`, a.offset);
  }
  return v;
}

function assembleCall(form: CallFormEntry, args: readonly ParsedArg[], callOffset: number): Expr {
  const vals: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  let ai = 0;
  const params = form.params;
  for (const p of params) {
    if (p.kind === 'exprRest') {
      const rest = args.slice(ai);
      if (rest.length < (p.min ?? 0)) fail(`${form.fn}() needs at least ${p.min ?? 0} argument(s)`, callOffset);
      vals[p.name] = rest.map((a) => a.expr);
      ai = args.length;
      continue;
    }
    if (p.kind === 'constRest') {
      const rest = args.slice(ai);
      if (rest.length < (p.min ?? 0)) fail(`${form.fn}() needs at least ${p.min ?? 0} argument(s)`, callOffset);
      vals[p.name] = rest.map((a) => expectConst(form.fn, p.name, a));
      ai = args.length;
      continue;
    }
    if (ai >= args.length) {
      if (p.optional) {
        vals[p.name] = p.default;
        continue;
      }
      fail(`${form.fn}() needs ${countRequired(params)} argument(s)`, callOffset);
    }
    const a = args[ai] as ParsedArg;
    ai++;
    vals[p.name] = coerceParam(form.fn, p, a);
  }
  if (ai < args.length) {
    const extra = args[ai] as ParsedArg;
    fail(`${form.fn}() takes at most ${params.length} argument(s)`, extra.offset);
  }
  return buildNode(form.op, vals, callOffset);
}

function assembleSwitch(args: readonly ParsedArg[], callOffset: number): Expr {
  if (args.length < 3 || args.length % 2 === 0) {
    fail('switch() needs condition/value pairs and a final else value', callOffset);
  }
  const cases: { when: Expr; then: Expr }[] = [];
  let i = 0;
  for (; i + 1 < args.length - 1; i += 2) {
    cases.push({ when: (args[i] as ParsedArg).expr, then: (args[i + 1] as ParsedArg).expr });
  }
  const elseExpr = (args[args.length - 1] as ParsedArg).expr;
  return { op: 'switch', cases, else: elseExpr };
}

/** Builds the exact `ExprNode` shape for every op whose `formula.form` is `'call'`
 * (everything except `add/sub/mul/div/eq/ne/gt/gte/lt/lte` - infix - and
 * `switch`/`call` - hand-written above). `vals` is keyed by the op's own
 * `OP_SIGNATURES[op].formula.params[].name`. */
function buildNode(op: SigOp, vals: Record<string, unknown>, callOffset: number): Expr {
  switch (op) {
    case 'neg':
      return { op: 'neg', arg: vals.arg as Expr };
    case 'abs':
      return { op: 'abs', arg: vals.arg as Expr };
    case 'floor':
      return { op: 'floor', arg: vals.arg as Expr };
    case 'ceil':
      return { op: 'ceil', arg: vals.arg as Expr };
    case 'mod':
      return { op: 'mod', args: [vals.a as Expr, vals.b as Expr] };
    case 'min':
      return { op: 'min', args: vals.args as Expr[] };
    case 'max':
      return { op: 'max', args: vals.args as Expr[] };
    case 'round':
      return { op: 'round', arg: vals.arg as Expr, digits: vals.digits as number };
    case 'concat':
      return { op: 'concat', args: vals.args as Expr[] };
    case 'substr':
      return { op: 'substr', arg: vals.arg as Expr, start: vals.start as number, length: vals.length as number };
    case 'trim':
      return { op: 'trim', arg: vals.arg as Expr };
    case 'upper':
      return { op: 'upper', arg: vals.arg as Expr };
    case 'lower':
      return { op: 'lower', arg: vals.arg as Expr };
    case 'length':
      return { op: 'length', arg: vals.arg as Expr };
    case 'replaceText':
      return { op: 'replaceText', arg: vals.arg as Expr, find: vals.find as string, with: vals.with as string };
    case 'padLeft':
      return { op: 'padLeft', arg: vals.arg as Expr, length: vals.length as number, char: vals.char as string };
    case 'split': {
      const index = vals.index as number;
      if (index === 0) fail('split()\'s "index" must be non-zero (1-based; negative counts from the end)', callOffset);
      return { op: 'split', arg: vals.arg as Expr, separator: vals.separator as string, index };
    }
    case 'toNumber':
      return { op: 'toNumber', arg: vals.arg as Expr };
    case 'toText':
      return vals.format === undefined ? { op: 'toText', arg: vals.arg as Expr } : { op: 'toText', arg: vals.arg as Expr, format: vals.format as string };
    case 'datePart':
      return { op: 'datePart', arg: vals.arg as Expr, part: vals.part as 'year' | 'month' | 'day' };
    case 'dateFormat':
      return { op: 'dateFormat', arg: vals.arg as Expr, format: vals.format as string };
    case 'dateAdd': {
      const amount = vals.amount as number;
      const unit = vals.unit as 'days' | 'months' | 'years';
      const arg = vals.arg as Expr;
      if (unit === 'days') return { op: 'dateAdd', arg, days: amount };
      if (unit === 'months') return { op: 'dateAdd', arg, months: amount };
      return { op: 'dateAdd', arg, years: amount };
    }
    case 'dateDiff':
      return { op: 'dateDiff', args: [vals.a as Expr, vals.b as Expr], unit: vals.unit as 'days' | 'months' | 'years' };
    case 'endOfMonth':
      return { op: 'endOfMonth', arg: vals.arg as Expr };
    case 'if':
      return { op: 'if', cond: vals.cond as Expr, then: vals.then as Expr, else: vals.else as Expr };
    case 'coalesce':
      return { op: 'coalesce', args: vals.args as Expr[] };
    case 'lookup':
      return {
        op: 'lookup',
        table: vals.table as string,
        key: vals.key as Expr,
        return: vals.return as string,
        onMissing: vals.onMissing as 'flag' | 'empty' | 'keep',
      };
    case 'isEmpty':
      return { op: 'isEmpty', arg: vals.arg as Expr };
    case 'notEmpty':
      return { op: 'notEmpty', arg: vals.arg as Expr };
    case 'oneOf':
      return { op: 'oneOf', arg: vals.arg as Expr, values: vals.values as ExprConstValue[] };
    case 'startsWith':
      return { op: 'startsWith', arg: vals.arg as Expr, text: vals.text as string };
    case 'endsWith':
      return { op: 'endsWith', arg: vals.arg as Expr, text: vals.text as string };
    case 'contains':
      return { op: 'contains', arg: vals.arg as Expr, text: vals.text as string };
    case 'and':
      return { op: 'and', args: vals.args as Expr[] };
    case 'or':
      return { op: 'or', args: vals.args as Expr[] };
    case 'not':
      return { op: 'not', arg: vals.arg as Expr };
    /* istanbul ignore next -- add/sub/mul/div/eq/ne/gt/gte/lt/lte are infix (handled in
     * the parser directly); switch/call are hand-written above. Neither reaches here. */
    default:
      throw new Error(`formula: op "${op}" has no generic call-form builder`);
  }
}

// ---------- Public entry point ----------

/**
 * Parses formula TEXT (learn-v5's LLM/editor wire format) into the same whitelisted
 * `Expr` AST the engine has always run. Never throws; a syntax problem comes back as
 * `{ ok: false, error: { message, offset } }` (SPEC 9.3: turned into a `formula`-kind
 * `RepairProblem` by `formulaRulesFromWire`, one layer up).
 */
export function parseFormula(text: string, ctx: FormulaParseContext = {}): FormulaParseResult {
  if (text.length > limits.rules.maxFormulaChars) {
    return {
      ok: false,
      error: { message: `formula text exceeds the maximum length of ${limits.rules.maxFormulaChars} characters`, offset: 0 },
    };
  }
  try {
    const tokens = tokenize(text);
    const expr = new Parser(tokens, ctx).parseTop();
    return { ok: true, expr };
  } catch (err) {
    if (err instanceof FormulaSyntaxError || err instanceof LexError) {
      return { ok: false, error: { message: err.message, offset: err.offset } };
    }
    throw err;
  }
}
