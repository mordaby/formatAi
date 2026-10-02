// The expression type-signature table (SPEC 8.3): "Every operation declares its
// argument and result types ... The signature table lives in `packages/engine` and is
// the single source for the type checker, the editor and the prompt." This file is
// that table, as data, plus the small type-lattice helpers (`widensTo`, `fits`,
// `unify`) every consumer needs to interpret it. `typeCheck.ts` is the only consumer
// built in this milestone; the rules-map editor and the prompt generator are future
// work (M1+) that should read this table rather than re-deriving it.
//
// Types (SPEC 8.3): "Every value has one type: text, idLike, integer, decimal, date or
// boolean." Leaves (`col`, `const`, `param`) are not operations and have no entry here;
// their types come from the column/param declaration or the literal's own JS type
// (see `typeCheck.ts`'s `inferConstType`).
import type { ExprNode, ValueType, WindowFn } from '@formatai/shared';
import { KEEP_CHARS_CLASSES, VALUE_TYPES, WINDOW_FNS } from '@formatai/shared';

export type SigType = ValueType;

// ---------- The widening lattice (SPEC 8.3) ----------
// "The only implicit widenings are integer -> decimal and idLike -> text. Anything
// else needs toNumber or toText." Every type also trivially "widens" to itself.

const WIDENS_TO: Readonly<Record<SigType, readonly SigType[]>> = {
  integer: ['integer', 'decimal'],
  decimal: ['decimal'],
  idLike: ['idLike', 'text'],
  text: ['text'],
  date: ['date'],
  boolean: ['boolean'],
};

/** True when a value of type `from` may be used, with no `toNumber`/`toText`, wherever
 * type `to` is expected (SPEC 8.3). Reflexive: every type widens to itself. */
export function widensTo(from: SigType, to: SigType): boolean {
  return WIDENS_TO[from].includes(to);
}

/** True when a value of type `actual` fits an expected slot. `'any'` accepts every
 * type (used for e.g. `toText`'s argument, `isEmpty`/`oneOf`'s subject). */
export function fits(actual: SigType, expected: SigType | 'any'): boolean {
  return expected === 'any' || widensTo(actual, expected);
}

/**
 * The tightest common type every one of `types` can widen to, or `undefined` when they
 * don't share one. This is both "unify branches" (`if`/`switch`/`coalesce`, SPEC 8.3:
 * "if{cond,then,else} ... unify branches") and "compare same-kind values" (`eq`/`ne`
 * and the other comparisons - see OP_SIGNATURES below).
 */
export function unify(types: readonly SigType[]): SigType | undefined {
  if (types.length === 0) return undefined;
  for (const candidate of VALUE_TYPES) {
    if (types.every((t) => widensTo(t, candidate))) return candidate;
  }
  return undefined;
}

// ---------- The signature table ----------

/** Every op that takes expression arguments (leaves `col`/`const`/`param` excluded). */
export type SigOp =
  | 'add'
  | 'sub'
  | 'mul'
  | 'div'
  | 'neg'
  | 'abs'
  | 'floor'
  | 'ceil'
  | 'mod'
  | 'min'
  | 'max'
  | 'round'
  | 'concat'
  | 'substr'
  | 'trim'
  | 'upper'
  | 'lower'
  | 'length'
  | 'replaceText'
  | 'padLeft'
  | 'split'
  | 'toNumber'
  | 'toText'
  | 'datePart'
  | 'dateFormat'
  | 'dateAdd'
  | 'dateDiff'
  | 'endOfMonth'
  | 'weekday'
  | 'makeDate'
  | 'toDate'
  | 'dateLiteral'
  | 'keepChars'
  | 'titleCase'
  | 'find'
  | 'window'
  | 'if'
  | 'switch'
  | 'coalesce'
  | 'lookup'
  | 'call'
  | 'eq'
  | 'ne'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'isEmpty'
  | 'notEmpty'
  | 'oneOf'
  | 'startsWith'
  | 'endsWith'
  | 'contains'
  | 'and'
  | 'or'
  | 'not';

/** How an op's result type is determined. */
export type ResultSpec =
  | { kind: 'fixed'; type: SigType }
  /** SPEC 8.3/LEARN_PROMPT: "arithmetic → decimal, integer when all args integer and
   * the op is add, sub, mul, mod, min or max." Every other arithmetic op (div, neg,
   * abs, floor, ceil, round) always returns decimal, even given only integer args. */
  | { kind: 'numericPreserveInteger' }
  /** if/switch/coalesce: the type all branches unify to (SPEC 8.3). */
  | { kind: 'unify' }
  /** eq/ne/gt/gte/lt/lte: always boolean, but only defined when the two operands
   * unify to a common type ("same-kind values"). */
  | { kind: 'boolean' }
  /** lookup/call: the result type isn't in this table at all - lookup's depends on the
   * values of the table column named by `return` (SPEC 8.14), call's on the callee
   * function's declared `returns` (SPEC 8.14). Resolved by `typeCheck.ts` against the
   * rules file's own `transform.tables`/`transform.functions`, not here. */
  | { kind: 'dynamic' };

/** How an op's Expr-valued argument(s) are shaped and typed. Non-Expr fields (e.g.
 * `round.digits`, `substr.start`/`length`, `padLeft.char`) are plain literals already
 * validated by the zod schema and have no entry here. */
export type ArgSpec =
  /** No Expr child at all: the op is written entirely from literal fields (`dateLiteral`). */
  | { shape: 'none' }
  /** Exactly one Expr child (the `arg` field), of the given type. */
  | { shape: 'unary'; type: SigType | 'any' }
  /** A fixed-length tuple of Expr children (the `args` field), all the same type. */
  | { shape: 'fixedSameType'; type: SigType; count: number }
  /** `args: Expr[]`, one or more, all the same type. */
  | { shape: 'variadicSameType'; type: SigType; min: number }
  /** `args: Expr[]`, one or more, whose types must all `unify` with each other
   * (used by coalesce, and by the comparison ops below). */
  | { shape: 'variadicUnify'; min: number }
  /** `if`: `cond` (boolean) then `then`/`else` (unify). */
  | { shape: 'if' }
  /** `switch`: each `cases[].when` (boolean), each `cases[].then` and `else` (unify
   * with each other). */
  | { shape: 'switch' }
  /** `lookup`: `key` may be any type (checked against the table's key-column values by
   * `typeCheck.ts`, not here - SPEC 8.14 tables aren't typed ahead of time). */
  | { shape: 'lookup' }
  /** `call`: each of `args[]` is checked against the callee's declared `params[].type`
   * by `typeCheck.ts` (arity is already checked by `checkRules`). */
  | { shape: 'call' }
  /** `window`: the column `arg` (typed per function, see WINDOW_SIGNATURES) plus `by`/`order` column ids of any type. */
  | { shape: 'window' };

// ---------- Formula syntax (learn-v5): the LLM/editor TEXT form of these same ops ----------
// SPEC 8.3/LEARN_PROMPT learn-v5: the LLM writes every expression as formula text (e.g.
// "round(amount * 0.17, 2)") instead of a JSON expression tree; `packages/engine/src/
// formula` parses that text into exactly the Expr AST this file already describes, and
// prints an Expr back to formula text. Two families are purely infix, parsed/printed by
// the core expression grammar itself, never as a function call: add/sub/mul/div ("+ - * /")
// and the six comparisons ("= <> < > <= >="). Every other op is written as a function call
// `fn(param1, param2, ...)` with a FIXED positional parameter order - defined ONCE here so
// the parser, the printer and the prompt generator can never drift apart from each other or
// from `args`/`result` above.
export type FormulaParamKind =
  | 'expr' // a full sub-expression
  | 'exprRest' // all remaining arguments, each a sub-expression (must be last)
  | 'constRest' // all remaining arguments, each a literal string/number/boolean/null (must be last)
  | 'int' // an integer literal (may be negative)
  | 'char' // a one-character string literal
  | 'string' // a string literal
  | { enum: readonly string[] }; // a string literal restricted to this fixed set

export interface FormulaParam {
  name: string;
  kind: FormulaParamKind;
  /** 'exprRest'/'constRest' only: the fewest arguments the rest may bind - SPEC 8.3's own
   * per-op minimum (e.g. and/or/concat/coalesce/min/max all need >= 1). */
  min?: number;
  /** A trailing param that may be omitted (e.g. toText's `format`, lookup's `onMissing` -
   * LEARN_PROMPT: "Set onMissing to flag", so that's its default when omitted). */
  optional?: boolean;
  default?: string;
}

export type FormulaForm =
  /** add/sub/mul/div and the six comparisons: parsed/printed by the core grammar's
   * infix operators, never as a function call. */
  | { form: 'infix'; symbol: string }
  /** Every other op: `fn(param1, param2, ...)`, in this fixed order. */
  | { form: 'call'; fn: string; params: FormulaParam[] }
  /** Irregular shapes the generic call-parameter machinery can't express: `switch`
   * (variadic cond/value pairs plus a trailing else) and the `call` op itself (not a
   * fixed keyword - it's the fallback for any OTHER identifier, SPEC 8.14's
   * `transform.functions`). Both are hand-written, once, in `formula/parseFormula.ts`
   * and `formula/printFormula.ts`. */
  | { form: 'special' };

export interface OpSignature {
  op: SigOp;
  args: ArgSpec;
  result: ResultSpec;
  /** A short human-readable signature, for the editor and the prompt (SPEC 8.3/8.14). */
  doc: string;
  /** The formula-text form of this op (see above). */
  formula: FormulaForm;
  /**
   * Whether the AI prompt (LEARN_PROMPT.md's "# Operations", `promptOpsSync.test.ts`) documents
   * this op. Omitted means true. `false` marks an op the formula parser, the editor's Advanced
   * view and the engine all support, but that the prompt does not mention yet (it ships with a
   * later prompt version): the sync test then skips it, and the API's LLM-answer check parses
   * formulas with `promptOpsOnly`, so such a name is an unknown function there. Delete the
   * flag when the prompt documents the op. (learn-v7 documented every op: no op carries the flag
   * today; the mechanism stays for the next op that is added before its prompt version.)
   */
  inPrompt?: false;
}

function call(fn: string, params: FormulaParam[]): FormulaForm {
  return { form: 'call', fn, params };
}
function infix(symbol: string): FormulaForm {
  return { form: 'infix', symbol };
}
const special: FormulaForm = { form: 'special' };
const arg: FormulaParam = { name: 'arg', kind: 'expr' };

const numericPreserve: ResultSpec = { kind: 'numericPreserveInteger' };
const decimalResult: ResultSpec = { kind: 'fixed', type: 'decimal' };
const textResult: ResultSpec = { kind: 'fixed', type: 'text' };
const integerResult: ResultSpec = { kind: 'fixed', type: 'integer' };
const dateResult: ResultSpec = { kind: 'fixed', type: 'date' };
const booleanFixed: ResultSpec = { kind: 'fixed', type: 'boolean' };
const compareResult: ResultSpec = { kind: 'boolean' };
const unifyResult: ResultSpec = { kind: 'unify' };
const dynamicResult: ResultSpec = { kind: 'dynamic' };

/** SPEC 8.3: arithmetic ops that stay integer when every argument is integer, and
 * decimal otherwise (`checkNumericPreserveInteger` in `typeCheck.ts` implements the
 * rule; this set only records which ops it applies to). */
export const INTEGER_PRESERVING_OPS: ReadonlySet<SigOp> = new Set([
  'add',
  'sub',
  'mul',
  'mod',
  'min',
  'max',
]);

/**
 * SPEC 8.3's "Operations" list, one entry per op, as data. `typeCheck.ts` reads this
 * table instead of hard-coding types inline; ops whose Expr tree shape is irregular
 * (`if`, `switch`, `lookup`, `call`) still get an entry here (for the editor/prompt and
 * for `result`), even though `typeCheck.ts` necessarily special-cases their traversal.
 */
export const OP_SIGNATURES: Readonly<Record<SigOp, OpSignature>> = {
  // ---- Arithmetic (SPEC 8.3) ----
  add: { op: 'add', args: { shape: 'variadicSameType', type: 'decimal', min: 1 }, result: numericPreserve, doc: '(decimal|integer, ...) -> decimal, or integer if every arg is integer', formula: infix('+') },
  sub: { op: 'sub', args: { shape: 'variadicSameType', type: 'decimal', min: 1 }, result: numericPreserve, doc: '(decimal|integer, ...) -> decimal, or integer if every arg is integer', formula: infix('-') },
  mul: { op: 'mul', args: { shape: 'variadicSameType', type: 'decimal', min: 1 }, result: numericPreserve, doc: '(decimal|integer, ...) -> decimal, or integer if every arg is integer', formula: infix('*') },
  div: { op: 'div', args: { shape: 'variadicSameType', type: 'decimal', min: 1 }, result: decimalResult, doc: '(decimal|integer, ...) -> decimal (dividing by zero flags the row)', formula: infix('/') },
  neg: { op: 'neg', args: { shape: 'unary', type: 'decimal' }, result: decimalResult, doc: '(decimal|integer) -> decimal', formula: call('neg', [arg]) },
  abs: { op: 'abs', args: { shape: 'unary', type: 'decimal' }, result: decimalResult, doc: '(decimal|integer) -> decimal', formula: call('abs', [arg]) },
  floor: { op: 'floor', args: { shape: 'unary', type: 'decimal' }, result: decimalResult, doc: '(decimal|integer) -> decimal', formula: call('floor', [arg]) },
  ceil: { op: 'ceil', args: { shape: 'unary', type: 'decimal' }, result: decimalResult, doc: '(decimal|integer) -> decimal', formula: call('ceil', [arg]) },
  mod: { op: 'mod', args: { shape: 'fixedSameType', type: 'decimal', count: 2 }, result: numericPreserve, doc: '(decimal|integer, decimal|integer) -> decimal, or integer if both args are integer', formula: call('mod', [{ name: 'a', kind: 'expr' }, { name: 'b', kind: 'expr' }]) },
  min: { op: 'min', args: { shape: 'variadicSameType', type: 'decimal', min: 1 }, result: numericPreserve, doc: '(decimal|integer, ...) -> decimal, or integer if every arg is integer', formula: call('min', [{ name: 'args', kind: 'exprRest', min: 1 }]) },
  max: { op: 'max', args: { shape: 'variadicSameType', type: 'decimal', min: 1 }, result: numericPreserve, doc: '(decimal|integer, ...) -> decimal, or integer if every arg is integer', formula: call('max', [{ name: 'args', kind: 'exprRest', min: 1 }]) },
  round: { op: 'round', args: { shape: 'unary', type: 'decimal' }, result: decimalResult, doc: '(decimal|integer) -> decimal (rounds half away from zero)', formula: call('round', [arg, { name: 'digits', kind: 'int' }]) },

  // ---- Text (SPEC 8.3: "text ops -> text") ----
  concat: { op: 'concat', args: { shape: 'variadicSameType', type: 'text', min: 1 }, result: textResult, doc: '(text|idLike, ...) -> text', formula: call('concat', [{ name: 'args', kind: 'exprRest', min: 1 }]) },
  substr: { op: 'substr', args: { shape: 'unary', type: 'text' }, result: textResult, doc: '(text|idLike) -> text', formula: call('substr', [arg, { name: 'start', kind: 'int' }, { name: 'length', kind: 'int' }]) },
  trim: { op: 'trim', args: { shape: 'unary', type: 'text' }, result: textResult, doc: '(text|idLike) -> text', formula: call('trim', [arg]) },
  upper: { op: 'upper', args: { shape: 'unary', type: 'text' }, result: textResult, doc: '(text|idLike) -> text', formula: call('upper', [arg]) },
  lower: { op: 'lower', args: { shape: 'unary', type: 'text' }, result: textResult, doc: '(text|idLike) -> text', formula: call('lower', [arg]) },
  // SPEC 8.3: "length ... -> integer" (the one text op that isn't text -> text).
  length: { op: 'length', args: { shape: 'unary', type: 'text' }, result: integerResult, doc: '(text|idLike) -> integer', formula: call('length', [arg]) },
  replaceText: { op: 'replaceText', args: { shape: 'unary', type: 'text' }, result: textResult, doc: '(text|idLike) -> text (literal find/with)', formula: call('replaceText', [arg, { name: 'find', kind: 'string' }, { name: 'with', kind: 'string' }]) },
  padLeft: { op: 'padLeft', args: { shape: 'unary', type: 'text' }, result: textResult, doc: '(text|idLike) -> text', formula: call('padLeft', [arg, { name: 'length', kind: 'int' }, { name: 'char', kind: 'char' }]) },
  split: { op: 'split', args: { shape: 'unary', type: 'text' }, result: textResult, doc: '(text|idLike) -> text (one part)', formula: call('split', [arg, { name: 'separator', kind: 'string' }, { name: 'index', kind: 'int' }]) },

  // ---- Conversion (SPEC 8.3) ----
  toNumber: { op: 'toNumber', args: { shape: 'unary', type: 'text' }, result: decimalResult, doc: '(text|idLike) -> decimal (a value that doesn\'t parse flags the row)', formula: call('toNumber', [arg]) },
  // toText's argument is deliberately unconstrained: it exists precisely to turn any
  // value (number, date, boolean, text) into text (SPEC 8.3: "toText{format?} (number
  // or date format)").
  toText: { op: 'toText', args: { shape: 'unary', type: 'any' }, result: textResult, doc: '(any) -> text', formula: call('toText', [arg, { name: 'format', kind: 'string', optional: true }]) },

  // ---- Dates (SPEC 8.3) ----
  datePart: { op: 'datePart', args: { shape: 'unary', type: 'date' }, result: integerResult, doc: '(date) -> integer', formula: call('datePart', [arg, { name: 'part', kind: { enum: ['year', 'month', 'day'] } }]) },
  dateFormat: { op: 'dateFormat', args: { shape: 'unary', type: 'date' }, result: textResult, doc: '(date) -> text', formula: call('dateFormat', [arg, { name: 'format', kind: 'string' }]) },
  dateAdd: { op: 'dateAdd', args: { shape: 'unary', type: 'date' }, result: dateResult, doc: '(date) -> date', formula: call('dateAdd', [arg, { name: 'amount', kind: 'int' }, { name: 'unit', kind: { enum: ['days', 'months', 'years'] } }]) },
  dateDiff: { op: 'dateDiff', args: { shape: 'fixedSameType', type: 'date', count: 2 }, result: integerResult, doc: '(date, date) -> integer', formula: call('dateDiff', [{ name: 'a', kind: 'expr' }, { name: 'b', kind: 'expr' }, { name: 'unit', kind: { enum: ['days', 'months', 'years'] } }]) },
  endOfMonth: { op: 'endOfMonth', args: { shape: 'unary', type: 'date' }, result: dateResult, doc: '(date) -> date', formula: call('endOfMonth', [arg]) },

  // ---- Added after learn-v6, documented in the prompt by learn-v7 (an op not yet in the prompt would carry `inPrompt: false`, see OpSignature.inPrompt) ----
  // DECISION: weekday numbers follow the Israeli week: 1 = Sunday ... 7 = Saturday (also Excel's
  // default WEEKDAY). Weekday NAMES are the `ddd`/`dddd` tokens of dateFormat/toText.
  weekday: { op: 'weekday', args: { shape: 'unary', type: 'date' }, result: integerResult, doc: '(date) -> integer (1 = Sunday ... 7 = Saturday)', formula: call('weekday', [arg]) },
  // DECISION: the three parts are decimal-typed (integer widens): a numeric column read as decimal
  // still works; a non-whole number, or a date that does not exist (month 13, 31 February, year
  // before 1900), gives an empty result and a "not a date" flag. An empty part gives an empty result.
  makeDate: { op: 'makeDate', args: { shape: 'fixedSameType', type: 'decimal', count: 3 }, result: dateResult, doc: '(year, month, day) -> date (an impossible date flags the row)', formula: call('makeDate', [{ name: 'year', kind: 'expr' }, { name: 'month', kind: 'expr' }, { name: 'day', kind: 'expr' }]) },
  // Reads TEXT (a text/idLike column or expression) with the same tokens as `inputFormats` (D, DD, M, MM,
  // YY, YYYY, literal separators) plus the month names MMMM / MMM in Hebrew or English. No day in the
  // format (`MMMM YYYY`) means the 1st. A text that does not match flags the row.
  toDate: { op: 'toDate', args: { shape: 'unary', type: 'text' }, result: dateResult, doc: '(text) -> date (a text that does not match the format flags the row)', formula: call('toDate', [arg, { name: 'format', kind: 'string' }]) },
  // DECISION: a date constant is its own op, written `date("2026-01-31")` (ISO only, checked when the
  // formula is read: a date that does not exist is a parse error) - rather than letting a text constant
  // stand in for a date, which would loosen the "only integer->decimal and idLike->text widen" rule.
  dateLiteral: { op: 'dateLiteral', args: { shape: 'none' }, result: dateResult, doc: '() -> date (a fixed date, YYYY-MM-DD)', formula: call('date', [{ name: 'value', kind: 'string' }]) },
  // `keepChars` classes (closed set, no patterns): digits = Unicode decimal digits; letters = Unicode
  // letters (Hebrew letters count; niqqud, punctuation and spaces do not); lettersAndDigits = both.
  keepChars: { op: 'keepChars', args: { shape: 'unary', type: 'text' }, result: textResult, doc: '(text|idLike) -> text (only the characters of the class)', formula: call('keepChars', [arg, { name: 'chars', kind: { enum: KEEP_CHARS_CLASSES } }]) },
  // DECISION: a word starts at the beginning of the text and after a space (any whitespace) or a hyphen;
  // its first letter is upper-cased, the rest lower-cased ("o'neil" -> "O'neil", "jean-luc" -> "Jean-Luc",
  // "3rd" stays "3rd"). Hebrew has no case and is unchanged.
  titleCase: { op: 'titleCase', args: { shape: 'unary', type: 'text' }, result: textResult, doc: '(text|idLike) -> text (first letter of each word upper case, the rest lower)', formula: call('titleCase', [arg]) },
  // DECISION: 1-based, counted in characters (code points, like substr/length); 0 when `search` is not
  // there; case-sensitive; literal text only. An empty text stays empty (like length).
  find: { op: 'find', args: { shape: 'unary', type: 'text' }, result: integerResult, doc: '(text|idLike) -> integer (position of the first occurrence of the literal text, 0 when absent)', formula: call('find', [arg, { name: 'search', kind: 'string' }]) },

  // ---- Across rows (docs/proposals/window-operations.md): ONE node, 11 functions (WINDOW_SIGNATURES below). ----
  // In the AI prompt since learn-v7 (before it was `inPrompt: false`: the API's LLM-answer parse, `promptOpsOnly`, took these names for
  // unknown functions). The formula parser reads `runningSum(amount, by: account)`.
  window: { op: 'window', args: { shape: 'window' }, result: dynamicResult, doc: 'across rows: runningSum, groupSum, groupAvg, groupMin, groupMax, groupCount, previous, next, fillDown, rowNumber, rank (named arguments by: and order:)', formula: special },

  // ---- Logic (SPEC 8.3: "conditions -> boolean"; if/switch/coalesce unify branches) ----
  if: { op: 'if', args: { shape: 'if' }, result: unifyResult, doc: '(boolean, T, T) -> T', formula: call('if', [{ name: 'cond', kind: 'expr' }, { name: 'then', kind: 'expr' }, { name: 'else', kind: 'expr' }]) },
  // switch's shape (variadic cond/value pairs, then a trailing else) doesn't fit the
  // generic positional-param model; hand-written in formula/parseFormula.ts and
  // formula/printFormula.ts, both documented there as: switch(cond1, value1, cond2,
  // value2, ..., elseValue).
  switch: { op: 'switch', args: { shape: 'switch' }, result: unifyResult, doc: '({boolean: T}[], else: T) -> T', formula: special },
  coalesce: { op: 'coalesce', args: { shape: 'variadicUnify', min: 1 }, result: unifyResult, doc: '(T, T, ...) -> T', formula: call('coalesce', [{ name: 'args', kind: 'exprRest', min: 1 }]) },

  // ---- Lookup / calls (SPEC 8.3, 8.14: resolved against the rules file's own tables/functions) ----
  lookup: {
    op: 'lookup',
    args: { shape: 'lookup' },
    result: dynamicResult,
    doc: '(key) -> the type of table.<return> (from its values)',
    formula: call('lookup', [
      { name: 'table', kind: 'string' },
      { name: 'key', kind: 'expr' },
      { name: 'return', kind: 'string' },
      { name: 'onMissing', kind: { enum: ['flag', 'empty', 'keep'] }, optional: true, default: 'flag' },
    ]),
  },
  // `call` isn't a fixed keyword: it's the fallback formula form for any identifier
  // that ISN'T one of these built-in ops (SPEC 8.14's `transform.functions`), so it has
  // no fixed `fn`/`params` of its own - hand-written in parseFormula.ts/printFormula.ts.
  call: { op: 'call', args: { shape: 'call' }, result: dynamicResult, doc: '(args matching the function\'s params) -> the function\'s declared `returns`', formula: special },

  // ---- Conditions (SPEC 8.3: "conditions -> boolean") ----
  // DECISION: SPEC 8.3 only spells out "eq/ne compare same-kind values" explicitly;
  // it doesn't separately restrict gt/gte/lt/lte to an orderable subset (numeric/date).
  // Treated identically to eq/ne here - both operands must `unify` to one type, exactly
  // as `if`/`switch`/`coalesce` do - rather than inventing an "orderable" type family
  // the spec never names.
  eq: { op: 'eq', args: { shape: 'variadicUnify', min: 2 }, result: compareResult, doc: '(T, T) -> boolean', formula: infix('=') },
  ne: { op: 'ne', args: { shape: 'variadicUnify', min: 2 }, result: compareResult, doc: '(T, T) -> boolean', formula: infix('<>') },
  gt: { op: 'gt', args: { shape: 'variadicUnify', min: 2 }, result: compareResult, doc: '(T, T) -> boolean', formula: infix('>') },
  gte: { op: 'gte', args: { shape: 'variadicUnify', min: 2 }, result: compareResult, doc: '(T, T) -> boolean', formula: infix('>=') },
  lt: { op: 'lt', args: { shape: 'variadicUnify', min: 2 }, result: compareResult, doc: '(T, T) -> boolean', formula: infix('<') },
  lte: { op: 'lte', args: { shape: 'variadicUnify', min: 2 }, result: compareResult, doc: '(T, T) -> boolean', formula: infix('<=') },
  isEmpty: { op: 'isEmpty', args: { shape: 'unary', type: 'any' }, result: booleanFixed, doc: '(any) -> boolean', formula: call('isEmpty', [arg]) },
  notEmpty: { op: 'notEmpty', args: { shape: 'unary', type: 'any' }, result: booleanFixed, doc: '(any) -> boolean', formula: call('notEmpty', [arg]) },
  oneOf: { op: 'oneOf', args: { shape: 'unary', type: 'any' }, result: booleanFixed, doc: '(any) -> boolean (against literal values)', formula: call('oneOf', [arg, { name: 'values', kind: 'constRest', min: 1 }]) },
  startsWith: { op: 'startsWith', args: { shape: 'unary', type: 'text' }, result: booleanFixed, doc: '(text|idLike) -> boolean', formula: call('startsWith', [arg, { name: 'text', kind: 'string' }]) },
  endsWith: { op: 'endsWith', args: { shape: 'unary', type: 'text' }, result: booleanFixed, doc: '(text|idLike) -> boolean', formula: call('endsWith', [arg, { name: 'text', kind: 'string' }]) },
  contains: { op: 'contains', args: { shape: 'unary', type: 'text' }, result: booleanFixed, doc: '(text|idLike) -> boolean', formula: call('contains', [arg, { name: 'text', kind: 'string' }]) },
  and: { op: 'and', args: { shape: 'variadicSameType', type: 'boolean', min: 1 }, result: booleanFixed, doc: '(boolean, ...) -> boolean', formula: call('and', [{ name: 'args', kind: 'exprRest', min: 1 }]) },
  or: { op: 'or', args: { shape: 'variadicSameType', type: 'boolean', min: 1 }, result: booleanFixed, doc: '(boolean, ...) -> boolean', formula: call('or', [{ name: 'args', kind: 'exprRest', min: 1 }]) },
  not: { op: 'not', args: { shape: 'unary', type: 'boolean' }, result: booleanFixed, doc: '(boolean) -> boolean', formula: call('not', [arg]) },
};

// ---------- Across-row ("window") functions ----------
// One `window` node, eleven functions. This table is the single source for what each function takes (the formula parser, the stored-JSON
// check in typeCheck, the editor and, once learn-v7 ships, the prompt) and what it returns. Semantics: pipeline/v1/window.ts.

/** What kind of column a window function's `arg` must be. */
export type WindowArgType = 'numeric' | 'numericOrDate' | 'any';

/** How the type of a window function's result is determined. */
export type WindowResult = 'numericPreserve' | 'decimal' | 'integer' | 'argType';

export interface WindowSignature {
  fn: WindowFn;
  /** The column the function reads: always given, optional (`groupCount`) or not taken (`rowNumber`, `rank`). */
  arg: 'required' | 'optional' | 'none';
  argType: WindowArgType;
  /** `order:` - not for the group functions (the order does not change a group's value), required for `rank`. */
  order: 'optional' | 'required' | 'none';
  /** `ties:` (`min` or `dense`) is for `rank` only. */
  ties: boolean;
  result: WindowResult;
  /** A short human-readable signature, for the editor and the prompt. */
  doc: string;
}

function win(
  fn: WindowFn,
  arg: WindowSignature['arg'],
  argType: WindowArgType,
  order: WindowSignature['order'],
  result: WindowResult,
  doc: string,
  ties = false,
): WindowSignature {
  return { fn, arg, argType, order, ties, result, doc };
}

export const WINDOW_SIGNATURES: Readonly<Record<WindowFn, WindowSignature>> = {
  runningSum: win('runningSum', 'required', 'numeric', 'optional', 'numericPreserve', 'runningSum(x[, by: g][, order: k]) -> sum of x from the first row of the group through this one'),
  groupSum: win('groupSum', 'required', 'numeric', 'none', 'numericPreserve', "groupSum(x[, by: g]) -> the group's total of x, on every row"),
  groupAvg: win('groupAvg', 'required', 'numeric', 'none', 'decimal', "groupAvg(x[, by: g]) -> the group's average of x (exact, unrounded), on every row"),
  groupMin: win('groupMin', 'required', 'numericOrDate', 'none', 'argType', "groupMin(x[, by: g]) -> the group's smallest x (a number or a date), on every row"),
  groupMax: win('groupMax', 'required', 'numericOrDate', 'none', 'argType', "groupMax(x[, by: g]) -> the group's largest x (a number or a date), on every row"),
  groupCount: win('groupCount', 'optional', 'any', 'none', 'integer', 'groupCount([x][, by: g]) -> rows in the group (with x: rows where x is not empty), on every row'),
  previous: win('previous', 'required', 'any', 'optional', 'argType', 'previous(x[, by: g][, order: k]) -> x on the row before (empty on the first row)'),
  next: win('next', 'required', 'any', 'optional', 'argType', 'next(x[, by: g][, order: k]) -> x on the row after (empty on the last row)'),
  fillDown: win('fillDown', 'required', 'any', 'optional', 'argType', 'fillDown(x[, by: g][, order: k]) -> the last x that is not empty, up to this row'),
  rowNumber: win('rowNumber', 'none', 'any', 'optional', 'integer', 'rowNumber([by: g][, order: k]) -> 1, 2, 3 ... within the group'),
  rank: win('rank', 'none', 'any', 'required', 'integer', 'rank(order: k[, by: g][, ties: min|dense]) -> position by k, first = 1; equal keys share a rank', true),
};

const WINDOW_FN_NAMES: ReadonlySet<string> = new Set<string>(WINDOW_FNS);

export function isWindowFn(name: string): name is WindowFn {
  return WINDOW_FN_NAMES.has(name);
}

/**
 * Why a window node does not have the shape its function takes, or `undefined` when it does: a missing or surplus column, `order` on a group
 * function, `ties` on anything but `rank`, `rank` without `order`. Used by the formula parser (with an offset) and by `typeCheck` for stored JSON.
 */
export function windowShapeProblem(node: Extract<ExprNode, { op: 'window' }>): string | undefined {
  const sig = WINDOW_SIGNATURES[node.fn];
  if (sig === undefined) return `unknown across-row function "${String(node.fn)}"`;
  if (sig.arg === 'required' && node.arg === undefined) return `${node.fn}() needs a column, e.g. ${node.fn}(amount)`;
  if (sig.arg === 'none' && node.arg !== undefined) {
    return `${node.fn}() takes no column; it works on rows (${sig.order === 'required' ? 'say what to rank by with order: ...' : 'use by: and order: to choose how'})`;
  }
  if (sig.order === 'none' && node.order !== undefined) return `${node.fn}() does not take order: the order does not change a group's value`;
  if (sig.order === 'required' && node.order === undefined) return `${node.fn}() needs order: to say what to rank by, e.g. ${node.fn}(order: sales desc)`;
  if (!sig.ties && node.ties !== undefined) return `${node.fn}() does not take ties:`;
  return undefined;
}
