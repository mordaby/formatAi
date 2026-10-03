// Expressions as sentences (SPEC 8.3, 8.11 "written as a sentence"). Two layers:
//   1. `describeExpr`: plain words for the shapes people actually use ("Cost × 1.18, rounded to
//      2 decimals", "first 3 characters of Code", "Code joined with Name, separated by ' - '").
//   2. anything else falls back to the formula text the engine's own printer writes
//      (`printFormula`), with column names swapped in for ids and × ÷ − for * / -.
// The printer is imported from the engine's pure `formula` entry point, never from the barrel:
// the main thread must not load the spreadsheet libraries.
import { printFormula } from '@formatai/engine/formula';
import type { Expr, ExprConstValue, ExprLeaf, ExprNode } from '@formatai/shared';
import type { Names } from './names';
import { joinWith, nm, normalize, partsText, quoted, txt, val } from './parts';
import type { Phrasebook } from './phrases';
import type { Part, SimplePart } from './types';

export interface Ctx {
  book: Phrasebook;
  names: Names;
}

// ---------------------------------------------------------------------------
// Names and values
// ---------------------------------------------------------------------------

/** A name part; an empty name shows as "(no name)" so a line never has a hole in it. */
export function namePart(ctx: Ctx, display: string): SimplePart {
  return nm(display === '' ? ctx.book.raw('word.unnamed') : display);
}

export function idPart(ctx: Ctx, id: string): SimplePart {
  const made = ctx.names.made(id);
  if (made !== undefined) return txt(ctx.book.raw(`made.${made}`));
  return namePart(ctx, ctx.names.display(id));
}

/** A name in the result's own words (the output header), for sorting, grouping and titles. */
export function outPart(ctx: Ctx, id: string): SimplePart {
  return namePart(ctx, ctx.names.output(id));
}

export function constPart(v: ExprConstValue, ctx: Ctx): SimplePart {
  if (v === null) return txt(ctx.book.raw('word.empty'));
  if (typeof v === 'string') return val(quoted(v));
  if (typeof v === 'boolean') return val(ctx.book.raw(v ? 'word.true' : 'word.false'));
  return val(String(v));
}

// ---------------------------------------------------------------------------
// Tree helpers
// ---------------------------------------------------------------------------

function isNode(e: Expr): e is Exclude<Expr, ExprLeaf> {
  return 'op' in e;
}

/** Rebuilds `e` with every leaf replaced by `f(leaf)`. */
function mapLeaves(e: Expr, f: (leaf: ExprLeaf) => Expr): Expr {
  if (!isNode(e)) return f(e);
  const out: Record<string, unknown> = { ...e };
  const any = e as unknown as Record<string, unknown>;
  const sub = (x: unknown): Expr => mapLeaves(x as Expr, f);
  if ('arg' in any) out.arg = sub(any.arg);
  if (Array.isArray(any.args)) out.args = any.args.map(sub);
  if (e.op === 'if') {
    out.cond = sub(e.cond);
    out.then = sub(e.then);
    out.else = sub(e.else);
  }
  if (e.op === 'switch') {
    out.cases = e.cases.map((c) => ({ when: sub(c.when), then: sub(c.then) }));
    out.else = sub(e.else);
  }
  if (e.op === 'lookup') out.key = sub(e.key);
  if (e.op === 'window') {
    // An across-row function names its group and order columns as ids; they are renamed like any column (a result that is not a column stays as it is).
    const ref = (id: string): string => {
      const r = f({ col: id });
      return 'col' in r ? r.col : id;
    };
    if (e.by !== undefined) out.by = e.by.map(ref);
    if (e.order !== undefined) out.order = e.order.map((k) => ({ ...k, column: ref(k.column) }));
  }
  return out as unknown as Expr;
}

/** Writes a helper column nobody shows (a computed id without an output column) inline. */
function expandHidden(e: Expr, ctx: Ctx, depth = 0, seen: readonly string[] = []): Expr {
  return mapLeaves(e, (leaf) => {
    if (!('col' in leaf)) return leaf;
    const hidden = ctx.names.hidden(leaf.col);
    if (hidden === undefined || depth >= 3 || seen.includes(leaf.col)) return leaf;
    return expandHidden(hidden, ctx, depth + 1, [...seen, leaf.col]);
  });
}

const ARITH = new Set(['add', 'sub', 'mul', 'div']);

/** Only columns, numbers and + − × ÷ (and a leading minus): reads fine inside a sentence. */
function isArithOnly(e: Expr): boolean {
  if (!isNode(e)) return true;
  if (e.op === 'neg') return isArithOnly(e.arg);
  if (e.op === 'add' || e.op === 'sub' || e.op === 'mul' || e.op === 'div') return e.args.every(isArithOnly);
  return false;
}

function isCompoundArith(e: Expr): boolean {
  return isNode(e) && ARITH.has(e.op);
}

// ---------------------------------------------------------------------------
// Formula text (the fallback)
// ---------------------------------------------------------------------------

const PH_OPEN = '';
const PH_CLOSE = '';

const OPERATORS: readonly (readonly [string, string])[] = [
  [' * ', ' × '],
  [' / ', ' ÷ '],
  [' - ', ' − '],
  [' <> ', ' ≠ '],
  [' >= ', ' ≥ '],
  [' <= ', ' ≤ '],
];

const isDigit = (c: string): boolean => c >= '0' && c <= '9';
const isIdentStart = (c: string): boolean => /[A-Za-z_]/.test(c);
const isIdentChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);

/**
 * Splits printed formula text into text / name / value pieces. Names arrive as placeholders
 * (so a header containing " * " can never be mistaken for an operator); quoted strings and
 * numbers become values; `* / -` become `× ÷ −`.
 */
function scanFormula(printed: string, names: readonly SimplePart[], unnamed: string): SimplePart[] {
  const out: SimplePart[] = [];
  let buf = '';
  const flush = (): void => {
    if (buf !== '') out.push(txt(buf));
    buf = '';
  };
  let i = 0;
  outer: while (i < printed.length) {
    const ch = printed.charAt(i);
    if (ch === PH_OPEN) {
      const end = printed.indexOf(PH_CLOSE, i);
      const n = Number(printed.slice(i + 1, end));
      flush();
      const piece = names[n];
      out.push(piece === undefined || piece.text === '' ? nm(unnamed) : piece);
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let literal = '';
      while (j < printed.length && printed.charAt(j) !== '"') {
        if (printed.charAt(j) === '\\' && j + 1 < printed.length) j++;
        literal += printed.charAt(j);
        j++;
      }
      flush();
      out.push(val(`"${literal}"`));
      i = j + 1;
      continue;
    }
    if (isDigit(ch) && !(i > 0 && isIdentChar(printed.charAt(i - 1)))) {
      let j = i;
      while (j < printed.length && (isDigit(printed.charAt(j)) || printed.charAt(j) === '.')) j++;
      flush();
      out.push(val(printed.slice(i, j)));
      i = j;
      continue;
    }
    if (isIdentStart(ch)) {
      let j = i;
      while (j < printed.length && isIdentChar(printed.charAt(j))) j++;
      buf += printed.slice(i, j);
      i = j;
      continue;
    }
    for (const [from, to] of OPERATORS) {
      if (printed.startsWith(from, i)) {
        buf += to;
        i += from.length;
        continue outer;
      }
    }
    buf += ch === '-' ? '−' : ch;
    i++;
  }
  flush();
  return out;
}

function plainNumber(n: number): string {
  if (Number.isInteger(n)) return BigInt(n).toString();
  return n.toFixed(20).replace(/0+$/, '');
}

/** An expression as formula text in pieces, or undefined when it can't be printed. */
export function formulaPieces(e: Expr, ctx: Ctx): SimplePart[] | undefined {
  const names: SimplePart[] = [];
  const placeholder = (piece: SimplePart): Expr => {
    names.push(piece);
    return { col: `${PH_OPEN}${names.length - 1}${PH_CLOSE}` };
  };
  const mapped = mapLeaves(expandHidden(e, ctx), (leaf) => {
    if ('const' in leaf) {
      // The printer refuses exponent notation (1e-7); write such a number out in full instead.
      return typeof leaf.const === 'number' && /e/i.test(String(leaf.const)) ? placeholder(val(plainNumber(leaf.const))) : leaf;
    }
    return placeholder('col' in leaf ? idPart(ctx, leaf.col) : nm(leaf.param));
  });
  try {
    return scanFormula(printFormula(mapped), names, ctx.book.raw('word.unnamed'));
  } catch {
    return undefined;
  }
}

export function formulaPart(pieces: readonly SimplePart[]): Part {
  return { kind: 'formula', text: partsText(pieces), parts: [...pieces] };
}

/**
 * A compact term: `Cost × 1.18` flows inline with the sentence; anything with function calls
 * (`round(…)`, `lookup(…)`) is one left-to-right formula part.
 */
export function termParts(e: Expr, ctx: Ctx): Part[] {
  const pieces = formulaPieces(e, ctx);
  if (pieces === undefined) return ctx.book.t('expr.custom');
  return isArithOnly(expandHidden(e, ctx)) ? pieces : [formulaPart(pieces)];
}

// ---------------------------------------------------------------------------
// Sentences
// ---------------------------------------------------------------------------

function paren(parts: readonly Part[]): Part[] {
  return [txt('('), ...parts, txt(')')];
}

function onlyFormula(parts: readonly Part[]): boolean {
  return parts.length === 1 && parts[0]?.kind === 'formula';
}

/** A piece that can sit inside a sentence: a name, a value, or a parenthesized sub-sentence. */
function operand(e: Expr, ctx: Ctx, loose = false): Part[] {
  if ('col' in e) return [idPart(ctx, e.col)];
  if ('param' in e) return [nm(e.param)];
  if ('const' in e) return [constPart(e.const, ctx)];
  if (isArithOnly(e)) {
    const p = termParts(e, ctx);
    return !loose && isCompoundArith(e) ? paren(p) : p;
  }
  const p = prose(e, ctx, false);
  return onlyFormula(p) ? p : paren(p);
}

function chain(inner: readonly Part[], mod: readonly Part[]): Part[] {
  return normalize([...inner, txt(', '), ...mod]);
}

function fixedValue(v: ExprConstValue, ctx: Ctx): Part[] {
  return v === null ? ctx.book.t('col.leftEmpty') : ctx.book.t('col.fixed', { v: constPart(v, ctx) });
}

const textOf = (s: string): SimplePart => val(quoted(s));

function concatParts(args: readonly Expr[], ctx: Ctx): Part[] {
  const { t, and } = ctx.book;
  const isConst = (x: Expr): x is { const: ExprConstValue } => 'const' in x;
  if (args.length >= 3 && args.length % 2 === 1) {
    const seps = args.filter((_, i) => i % 2 === 1);
    const things = args.filter((_, i) => i % 2 === 0);
    const first = seps[0];
    if (
      first !== undefined &&
      isConst(first) &&
      typeof first.const === 'string' &&
      first.const !== '' &&
      seps.every((s) => isConst(s) && s.const === first.const) &&
      things.every((x) => !isConst(x))
    ) {
      const sep = first.const === ' ' ? txt(ctx.book.raw('word.space')) : textOf(first.const);
      const [head, ...rest] = things.map((x) => operand(x, ctx));
      return t('expr.joinedSep', { first: head ?? [], rest: and(rest), sep });
    }
  }
  if (args.length >= 2 && args.every((x) => !isConst(x))) {
    const [head, ...rest] = args.map((x) => operand(x, ctx));
    return t('expr.joined', { first: head ?? [], rest: and(rest) });
  }
  return t('expr.textOf', { items: and(args.map((x) => operand(x, ctx, true))) });
}

function substrParts(e: { arg: Expr; start: number; length: number }, ctx: Ctx): Part[] {
  const { t, tn } = ctx.book;
  const x = operand(e.arg, ctx);
  if (e.start === 1) return tn('expr.firstChars', e.length, { x });
  if (e.start < 0 && e.start === -e.length) return tn('expr.lastChars', e.length, { x });
  if (e.start < 0) return t('expr.charsFromEnd', { n: String(e.length), x, p: String(-e.start) });
  return t('expr.charsFrom', { n: String(e.length), x, p: String(e.start) });
}

/** A condition as a sentence fragment: "Status is not 'Cancelled'". */
export function conditionParts(e: Expr, ctx: Ctx, nested = false): Part[] {
  const { t, or } = ctx.book;
  if (!isNode(e)) return operand(e, ctx);
  switch (e.op) {
    case 'eq':
    case 'ne':
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      return t(`cond.${e.op}`, { a: operand(e.args[0], ctx, true), b: operand(e.args[1], ctx, true) });
    case 'isEmpty':
    case 'notEmpty':
      return t(`cond.${e.op}`, { a: operand(e.arg, ctx, true) });
    case 'oneOf':
      return t('cond.oneOf', { a: operand(e.arg, ctx, true), values: or(e.values.map((v) => [constPart(v, ctx)])) });
    case 'startsWith':
    case 'endsWith':
    case 'contains':
      return t(`cond.${e.op}`, { a: operand(e.arg, ctx, true), b: textOf(e.text) });
    case 'and':
    case 'or': {
      const joined = joinWith(
        e.args.map((a) => conditionParts(a, ctx, true)),
        ctx.book.raw(e.op === 'and' ? 'cond.andJoin' : 'cond.orJoin'),
      );
      return nested ? paren(joined) : joined;
    }
    case 'not':
      return t('cond.not', { c: conditionParts(e.arg, ctx, false) });
    default:
      return prose(e, ctx, false);
  }
}

const WINDOW_GROUP_FNS: ReadonlySet<string> = new Set(['groupSum', 'groupAvg', 'groupMin', 'groupMax', 'groupCount']);

/**
 * An across-row (window) function as a sentence: "running total of Amount per Agent, in file order",
 * "rank by Sales (descending), equal values share a rank", "the total of Amount per Department".
 */
function windowParts(e: Extract<ExprNode, { op: 'window' }>, ctx: Ctx): Part[] {
  const { t, and } = ctx.book;
  const x = e.arg === undefined ? [] : operand(e.arg, ctx);
  const keys = joinWith(
    (e.order ?? []).map((k): Part[] => [idPart(ctx, k.column), ...(k.dir === 'desc' ? [txt(' '), ...t('sort.desc.plain')] : [])]),
    ctx.book.raw('win.then'),
  );
  const head = e.fn === 'groupCount' ? t(e.arg === undefined ? 'expr.win.groupCount' : 'expr.win.groupCountOf', { x }) : t(`expr.win.${e.fn}`, { x, keys });
  const isGroupFn = WINDOW_GROUP_FNS.has(e.fn);
  const hasBy = e.by !== undefined && e.by.length > 0;
  // "per Agent" follows the head after a space; the order, or what ties mean, comes after a comma.
  const group: Part[] | undefined = hasBy ? t('win.perGroup', { by: and((e.by ?? []).map((id): Part[] => [idPart(ctx, id)])) }) : isGroupFn ? t('win.allRows') : undefined;
  const after: Part[][] = [];
  if (e.fn === 'rank') after.push(t(e.ties === 'dense' ? 'win.tiesDense' : 'win.tiesMin'));
  else if (!isGroupFn) after.push(e.order !== undefined && e.order.length > 0 ? t('win.orderBy', { keys }) : t('win.fileOrder'));
  return normalize([...head, ...(group ? [txt(' '), ...group] : []), ...after.flatMap((p) => [txt(', '), ...p])]);
}

function prose(e: Expr, ctx: Ctx, top: boolean): Part[] {
  const { t, tn, and } = ctx.book;
  if ('col' in e) return [idPart(ctx, e.col)];
  if ('param' in e) return [nm(e.param)];
  if ('const' in e) return top ? fixedValue(e.const, ctx) : [constPart(e.const, ctx)];

  switch (e.op) {
    case 'round': {
      const mod =
        e.digits > 0
          ? tn('decimals', e.digits)
          : e.digits === 0
            ? t('mod.roundedWhole')
            : t('mod.roundedNearest', { step: val(String(10 ** -e.digits)) });
      return chain(prose(e.arg, ctx, false), mod);
    }
    case 'padLeft':
      return chain(
        prose(e.arg, ctx, false),
        e.char === '0'
          ? t('mod.padDigits', { n: String(e.length) })
          : t('mod.padChars', { n: String(e.length), c: textOf(e.char) }),
      );
    case 'trim':
      return chain(prose(e.arg, ctx, false), t('mod.trimmed'));
    case 'upper':
      return chain(prose(e.arg, ctx, false), t('mod.upper'));
    case 'lower':
      return chain(prose(e.arg, ctx, false), t('mod.lower'));
    case 'floor':
      return chain(prose(e.arg, ctx, false), t('mod.floor'));
    case 'ceil':
      return chain(prose(e.arg, ctx, false), t('mod.ceil'));
    case 'toNumber':
      return chain(prose(e.arg, ctx, false), t('mod.asNumber'));
    case 'toText':
      return chain(
        prose(e.arg, ctx, false),
        e.format === undefined ? t('mod.asText') : t('mod.asTextFormat', { f: val(e.format) }),
      );
    case 'abs':
      return t('expr.abs', { x: operand(e.arg, ctx) });
    case 'substr':
      return substrParts(e, ctx);
    case 'concat':
      return concatParts(e.args, ctx);
    case 'length':
      return t('expr.length', { x: operand(e.arg, ctx) });
    case 'replaceText': {
      if (e.with !== '' || e.find === '') {
        return t('expr.replace', { x: operand(e.arg, ctx), find: textOf(e.find), with: textOf(e.with) });
      }
      // Several removals in a row read as one: "Phone with '-' and ' ' removed".
      const finds = [e.find];
      let inner: Expr = e.arg;
      while (isNode(inner) && inner.op === 'replaceText' && inner.with === '' && inner.find !== '') {
        finds.unshift(inner.find);
        inner = inner.arg;
      }
      return t('expr.remove', { x: operand(inner, ctx), find: and(finds.map((f): Part[] => [textOf(f)])) });
    }
    case 'split': {
      const base = { x: operand(e.arg, ctx), sep: textOf(e.separator) };
      if (e.index === -1) return t('expr.splitLast', base);
      if (e.index < 0) return t('expr.splitFromEnd', { ...base, n: String(-e.index) });
      return t('expr.split', { ...base, n: String(e.index) });
    }
    case 'datePart':
      return t(`expr.datePart.${e.part}`, { x: operand(e.arg, ctx) });
    case 'dateFormat':
      return t('expr.dateFormat', { x: operand(e.arg, ctx), f: val(e.format) });
    case 'dateAdd': {
      const unit = e.days !== undefined ? 'days' : e.months !== undefined ? 'months' : 'years';
      const amount = e.days ?? e.months ?? e.years ?? 0;
      return t(amount < 0 ? 'expr.dateMinus' : 'expr.datePlus', {
        x: operand(e.arg, ctx),
        amount: tn(unit, Math.abs(amount)),
      });
    }
    case 'dateDiff':
      return t('expr.dateDiff', {
        unit: t(`unit.${e.unit}`),
        a: operand(e.args[0], ctx),
        b: operand(e.args[1], ctx),
      });
    case 'endOfMonth':
      return t('expr.endOfMonth', { x: operand(e.arg, ctx) });
    case 'if':
      return t('expr.if', {
        then: operand(e.then, ctx, true),
        cond: conditionParts(e.cond, ctx),
        else: operand(e.else, ctx, true),
      });
    case 'switch': {
      const cases = e.cases.map((c) => t('expr.case', { then: operand(c.then, ctx, true), when: conditionParts(c.when, ctx) }));
      return joinWith([...cases, t('expr.otherwise', { else: operand(e.else, ctx, true) })], '; ');
    }
    case 'coalesce':
      return t('expr.coalesce', { items: and(e.args.map((x) => operand(x, ctx, true))) });
    case 'min':
      return t('expr.min', { items: and(e.args.map((x) => operand(x, ctx, true))) });
    case 'max':
      return t('expr.max', { items: and(e.args.map((x) => operand(x, ctx, true))) });
    case 'mod':
      return t('expr.mod', { a: operand(e.args[0], ctx), b: operand(e.args[1], ctx) });
    case 'lookup':
      return joinWith(
        [
          t('expr.lookup', { ret: nm(e.return), table: nm(quoted(e.table)), key: operand(e.key, ctx) }),
          t(`expr.lookupMissing.${e.onMissing}`),
        ],
        ' ',
      );
    case 'window':
      return windowParts(e, ctx);
    case 'eq':
    case 'ne':
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
    case 'isEmpty':
    case 'notEmpty':
    case 'oneOf':
    case 'startsWith':
    case 'endsWith':
    case 'contains':
    case 'and':
    case 'or':
    case 'not':
      return t('expr.condValue', { cond: conditionParts(e, ctx) });
    default:
      // add / sub / mul / div / neg and function calls: formula text.
      return termParts(e, ctx);
  }
}

/**
 * An output column's calculation in plain words. `top` makes a bare constant read as
 * "fixed value 'ILS'" (instead of just the value).
 */
export function describeExpr(e: Expr, ctx: Ctx, top = false): Part[] {
  return prose(expandHidden(e, ctx), ctx, top);
}
