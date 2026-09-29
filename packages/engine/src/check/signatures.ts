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
import type { ValueType } from '@formatai/shared';
import { VALUE_TYPES } from '@formatai/shared';

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
  | { shape: 'call' };

export interface OpSignature {
  op: SigOp;
  args: ArgSpec;
  result: ResultSpec;
  /** A short human-readable signature, for the editor and the prompt (SPEC 8.3/8.14). */
  doc: string;
}

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
  add: { op: 'add', args: { shape: 'variadicSameType', type: 'decimal', min: 1 }, result: numericPreserve, doc: '(decimal|integer, ...) -> decimal, or integer if every arg is integer' },
  sub: { op: 'sub', args: { shape: 'variadicSameType', type: 'decimal', min: 1 }, result: numericPreserve, doc: '(decimal|integer, ...) -> decimal, or integer if every arg is integer' },
  mul: { op: 'mul', args: { shape: 'variadicSameType', type: 'decimal', min: 1 }, result: numericPreserve, doc: '(decimal|integer, ...) -> decimal, or integer if every arg is integer' },
  div: { op: 'div', args: { shape: 'variadicSameType', type: 'decimal', min: 1 }, result: decimalResult, doc: '(decimal|integer, ...) -> decimal (dividing by zero flags the row)' },
  neg: { op: 'neg', args: { shape: 'unary', type: 'decimal' }, result: decimalResult, doc: '(decimal|integer) -> decimal' },
  abs: { op: 'abs', args: { shape: 'unary', type: 'decimal' }, result: decimalResult, doc: '(decimal|integer) -> decimal' },
  floor: { op: 'floor', args: { shape: 'unary', type: 'decimal' }, result: decimalResult, doc: '(decimal|integer) -> decimal' },
  ceil: { op: 'ceil', args: { shape: 'unary', type: 'decimal' }, result: decimalResult, doc: '(decimal|integer) -> decimal' },
  mod: { op: 'mod', args: { shape: 'fixedSameType', type: 'decimal', count: 2 }, result: numericPreserve, doc: '(decimal|integer, decimal|integer) -> decimal, or integer if both args are integer' },
  min: { op: 'min', args: { shape: 'variadicSameType', type: 'decimal', min: 1 }, result: numericPreserve, doc: '(decimal|integer, ...) -> decimal, or integer if every arg is integer' },
  max: { op: 'max', args: { shape: 'variadicSameType', type: 'decimal', min: 1 }, result: numericPreserve, doc: '(decimal|integer, ...) -> decimal, or integer if every arg is integer' },
  round: { op: 'round', args: { shape: 'unary', type: 'decimal' }, result: decimalResult, doc: '(decimal|integer) -> decimal (rounds half away from zero)' },

  // ---- Text (SPEC 8.3: "text ops -> text") ----
  concat: { op: 'concat', args: { shape: 'variadicSameType', type: 'text', min: 1 }, result: textResult, doc: '(text|idLike, ...) -> text' },
  substr: { op: 'substr', args: { shape: 'unary', type: 'text' }, result: textResult, doc: '(text|idLike) -> text' },
  trim: { op: 'trim', args: { shape: 'unary', type: 'text' }, result: textResult, doc: '(text|idLike) -> text' },
  upper: { op: 'upper', args: { shape: 'unary', type: 'text' }, result: textResult, doc: '(text|idLike) -> text' },
  lower: { op: 'lower', args: { shape: 'unary', type: 'text' }, result: textResult, doc: '(text|idLike) -> text' },
  // SPEC 8.3: "length ... -> integer" (the one text op that isn't text -> text).
  length: { op: 'length', args: { shape: 'unary', type: 'text' }, result: integerResult, doc: '(text|idLike) -> integer' },
  replaceText: { op: 'replaceText', args: { shape: 'unary', type: 'text' }, result: textResult, doc: '(text|idLike) -> text (literal find/with)' },
  padLeft: { op: 'padLeft', args: { shape: 'unary', type: 'text' }, result: textResult, doc: '(text|idLike) -> text' },
  split: { op: 'split', args: { shape: 'unary', type: 'text' }, result: textResult, doc: '(text|idLike) -> text (one part)' },

  // ---- Conversion (SPEC 8.3) ----
  toNumber: { op: 'toNumber', args: { shape: 'unary', type: 'text' }, result: decimalResult, doc: '(text|idLike) -> decimal (a value that doesn\'t parse flags the row)' },
  // toText's argument is deliberately unconstrained: it exists precisely to turn any
  // value (number, date, boolean, text) into text (SPEC 8.3: "toText{format?} (number
  // or date format)").
  toText: { op: 'toText', args: { shape: 'unary', type: 'any' }, result: textResult, doc: '(any) -> text' },

  // ---- Dates (SPEC 8.3) ----
  datePart: { op: 'datePart', args: { shape: 'unary', type: 'date' }, result: integerResult, doc: '(date) -> integer' },
  dateFormat: { op: 'dateFormat', args: { shape: 'unary', type: 'date' }, result: textResult, doc: '(date) -> text' },
  dateAdd: { op: 'dateAdd', args: { shape: 'unary', type: 'date' }, result: dateResult, doc: '(date) -> date' },
  dateDiff: { op: 'dateDiff', args: { shape: 'fixedSameType', type: 'date', count: 2 }, result: integerResult, doc: '(date, date) -> integer' },
  endOfMonth: { op: 'endOfMonth', args: { shape: 'unary', type: 'date' }, result: dateResult, doc: '(date) -> date' },

  // ---- Logic (SPEC 8.3: "conditions -> boolean"; if/switch/coalesce unify branches) ----
  if: { op: 'if', args: { shape: 'if' }, result: unifyResult, doc: '(boolean, T, T) -> T' },
  switch: { op: 'switch', args: { shape: 'switch' }, result: unifyResult, doc: '({boolean: T}[], else: T) -> T' },
  coalesce: { op: 'coalesce', args: { shape: 'variadicUnify', min: 1 }, result: unifyResult, doc: '(T, T, ...) -> T' },

  // ---- Lookup / calls (SPEC 8.3, 8.14: resolved against the rules file's own tables/functions) ----
  lookup: { op: 'lookup', args: { shape: 'lookup' }, result: dynamicResult, doc: '(key) -> the type of table.<return> (from its values)' },
  call: { op: 'call', args: { shape: 'call' }, result: dynamicResult, doc: '(args matching the function\'s params) -> the function\'s declared `returns`' },

  // ---- Conditions (SPEC 8.3: "conditions -> boolean") ----
  // DECISION: SPEC 8.3 only spells out "eq/ne compare same-kind values" explicitly;
  // it doesn't separately restrict gt/gte/lt/lte to an orderable subset (numeric/date).
  // Treated identically to eq/ne here - both operands must `unify` to one type, exactly
  // as `if`/`switch`/`coalesce` do - rather than inventing an "orderable" type family
  // the spec never names.
  eq: { op: 'eq', args: { shape: 'variadicUnify', min: 2 }, result: compareResult, doc: '(T, T) -> boolean' },
  ne: { op: 'ne', args: { shape: 'variadicUnify', min: 2 }, result: compareResult, doc: '(T, T) -> boolean' },
  gt: { op: 'gt', args: { shape: 'variadicUnify', min: 2 }, result: compareResult, doc: '(T, T) -> boolean' },
  gte: { op: 'gte', args: { shape: 'variadicUnify', min: 2 }, result: compareResult, doc: '(T, T) -> boolean' },
  lt: { op: 'lt', args: { shape: 'variadicUnify', min: 2 }, result: compareResult, doc: '(T, T) -> boolean' },
  lte: { op: 'lte', args: { shape: 'variadicUnify', min: 2 }, result: compareResult, doc: '(T, T) -> boolean' },
  isEmpty: { op: 'isEmpty', args: { shape: 'unary', type: 'any' }, result: booleanFixed, doc: '(any) -> boolean' },
  notEmpty: { op: 'notEmpty', args: { shape: 'unary', type: 'any' }, result: booleanFixed, doc: '(any) -> boolean' },
  oneOf: { op: 'oneOf', args: { shape: 'unary', type: 'any' }, result: booleanFixed, doc: '(any) -> boolean (against literal values)' },
  startsWith: { op: 'startsWith', args: { shape: 'unary', type: 'text' }, result: booleanFixed, doc: '(text|idLike) -> boolean' },
  endsWith: { op: 'endsWith', args: { shape: 'unary', type: 'text' }, result: booleanFixed, doc: '(text|idLike) -> boolean' },
  contains: { op: 'contains', args: { shape: 'unary', type: 'text' }, result: booleanFixed, doc: '(text|idLike) -> boolean' },
  and: { op: 'and', args: { shape: 'variadicSameType', type: 'boolean', min: 1 }, result: booleanFixed, doc: '(boolean, ...) -> boolean' },
  or: { op: 'or', args: { shape: 'variadicSameType', type: 'boolean', min: 1 }, result: booleanFixed, doc: '(boolean, ...) -> boolean' },
  not: { op: 'not', args: { shape: 'unary', type: 'boolean' }, result: booleanFixed, doc: '(boolean) -> boolean' },
};
