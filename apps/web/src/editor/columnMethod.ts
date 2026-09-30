// "How is it made?" (SPEC 8.11 Column editor): the seven ways an output column is made, in both
// directions. `applyColumnMethod` turns a choice into rules (computed columns with generated ids,
// formula ASTs, value maps); `readColumnMethod` turns the rules back into the choice the editor
// shows, and says `formula` (Advanced) for anything it would not build itself.
import type { ColumnType, Computed, Expr, ValueMap, ValueType } from '@formatai/shared';
import { canonicalizeExpr, parseFormula, printFormula } from '@formatai/engine/formula';
import { editorConfig } from './config';
import { fail } from './problems';
import {
  colRefs,
  freshId,
  idInfos,
  NUMERIC,
  ownedComputedId,
  pruneComputed,
  pruneValueMaps,
  referencedIds,
  stable,
} from './rulesUtil';
import type { CalcOp, CalcTerm, ColumnMethod, EditableRules, EditProblem, TranslatePair } from './types';

type Out = EditableRules | EditProblem[];

const OP_NAME = { '+': 'add', '-': 'sub', '*': 'mul', '/': 'div' } as const;
const OP_OF = { add: '+', sub: '-', mul: '*', div: '/' } as const;

const isTextLike = (t: ValueType | undefined): boolean => t === 'text' || t === 'idLike';

// ---------- the mismatch wording of the engine's own type checker ----------

/** `expected decimal, got text; use toNumber` - the same sentence `typeCheck` gives for the same mistake. */
export function mismatchMessage(expected: ValueType, actual: ValueType): string {
  let suggestion = '';
  if ((expected === 'decimal' || expected === 'integer') && (actual === 'text' || actual === 'idLike')) suggestion = '; use toNumber';
  else if (expected === 'text' && actual !== 'text' && actual !== 'idLike') suggestion = '; use toText';
  return `expected ${expected}, got ${actual}${suggestion}`;
}

// ---------- building expressions ----------

const col = (id: string): Expr => ({ col: id });

/** A column used where text is expected: numbers, dates and booleans go through `toText`. */
function asText(id: string, type: ValueType | undefined): Expr {
  return type === undefined || isTextLike(type) ? col(id) : { op: 'toText', arg: col(id) };
}

export function buildCopyExpr(source: string, type: ValueType | undefined, m: { padLeft?: number; trim?: boolean }): Expr {
  let e: Expr = asText(source, type);
  if (m.trim) e = { op: 'trim', arg: e };
  if (m.padLeft) e = { op: 'padLeft', arg: e, length: m.padLeft, char: '0' };
  return e;
}

function termExpr(t: CalcTerm, typeOf: (id: string) => ValueType | undefined): Expr {
  if ('number' in t) return { const: t.number };
  const type = typeOf(t.column);
  return t.toNumber && isTextLike(type) ? { op: 'toNumber', arg: col(t.column) } : col(t.column);
}

/** Standard precedence (x and / before + and -), the same tree the formula parser builds for the printed text. */
export function buildCalcExpr(terms: CalcTerm[], ops: CalcOp[], round: number | undefined, typeOf: (id: string) => ValueType | undefined): Expr {
  const t = terms.map((x) => termExpr(x, typeOf));
  let e: Expr;
  if (t.length === 1) e = t[0]!;
  else if (t.length === 2) e = { op: OP_NAME[ops[0]!], args: [t[0]!, t[1]!] };
  else {
    const [o1, o2] = [ops[0]!, ops[1]!];
    const high = (o: CalcOp): boolean => o === '*' || o === '/';
    e =
      !high(o1) && high(o2)
        ? { op: OP_NAME[o1], args: [t[0]!, { op: OP_NAME[o2], args: [t[1]!, t[2]!] }] }
        : { op: OP_NAME[o2], args: [{ op: OP_NAME[o1], args: [t[0]!, t[1]!] }, t[2]!] };
  }
  e = canonicalizeExpr(e);
  return round === undefined ? e : { op: 'round', arg: e, digits: round };
}

export function buildJoinExpr(
  columns: string[],
  separator: string,
  typeOf: (id: string) => ValueType | undefined,
  fixed: { before?: string; after?: string } = {},
): Expr {
  const args: Expr[] = [];
  if (fixed.before) args.push({ const: fixed.before });
  columns.forEach((c, i) => {
    if (i > 0 && separator !== '') args.push({ const: separator });
    args.push(asText(c, typeOf(c)));
  });
  if (fixed.after) args.push({ const: fixed.after });
  return { op: 'concat', args };
}

export function buildPartExpr(source: string, type: ValueType | undefined, part: 'first' | 'last', n: number): Expr {
  const arg = asText(source, type);
  return part === 'first' ? { op: 'substr', arg, start: 1, length: n } : { op: 'substr', arg, start: -n, length: n };
}

function constType(v: string | number | boolean): ColumnType {
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'decimal';
  return 'text';
}

// ---------- reading (rules -> the choice) ----------

function isLeafCol(e: Expr): e is { col: string } {
  return 'col' in e;
}

/** `col`, or `toText(col)`: the source of a text operation. */
function textSource(e: Expr): { col: string } | undefined {
  if (isLeafCol(e)) return e;
  if ('op' in e && e.op === 'toText' && e.format === undefined && isLeafCol(e.arg)) return e.arg;
  return undefined;
}

function sameExpr(a: Expr, b: Expr): boolean {
  return stable(canonicalizeExpr(a)) === stable(canonicalizeExpr(b));
}

/** In-order leaves and operators of a chain of + - x /, ignoring the tree's brackets (verified by rebuilding). */
function flattenArith(e: Expr, terms: Expr[], ops: CalcOp[]): boolean {
  if ('op' in e && (e.op === 'add' || e.op === 'sub' || e.op === 'mul' || e.op === 'div')) {
    e.args.forEach((a, i) => {
      if (i > 0) ops.push(OP_OF[e.op as keyof typeof OP_OF]);
      flattenArith(a, terms, ops);
    });
    return true;
  }
  terms.push(e);
  return true;
}

function readTerm(e: Expr): CalcTerm | undefined {
  if ('const' in e) return typeof e.const === 'number' ? { number: e.const } : undefined;
  if (isLeafCol(e)) return { column: e.col };
  if ('op' in e && e.op === 'toNumber' && isLeafCol(e.arg)) return { column: e.arg.col, toNumber: true };
  return undefined;
}

function readCalc(e: Expr, typeOf: (id: string) => ValueType | undefined): ColumnMethod | undefined {
  let inner = e;
  let round: number | undefined;
  if ('op' in e && e.op === 'round') {
    inner = e.arg;
    round = e.digits;
  }
  const termExprs: Expr[] = [];
  const ops: CalcOp[] = [];
  flattenArith(inner, termExprs, ops);
  if (termExprs.length > editorConfig.maxCalcTerms) return undefined;
  if (termExprs.length === 1 && round === undefined) return undefined; // a bare column/number is not a calculation
  const terms: CalcTerm[] = [];
  for (const t of termExprs) {
    const term = readTerm(t);
    if (!term) return undefined;
    terms.push(term);
  }
  const method: ColumnMethod = { kind: 'calculate', terms, ops, ...(round === undefined ? {} : { round }) };
  return sameExpr(buildCalcExpr(terms, ops, round, typeOf), e) ? method : undefined;
}

const isTextConst = (e: Expr): e is { const: string } => 'const' in e && typeof e.const === 'string';

function readJoin(e: Expr, typeOf: (id: string) => ValueType | undefined): ColumnMethod | undefined {
  if (!('op' in e) || e.op !== 'concat') return undefined;
  // Fixed text may open and close the join; a separator goes between the columns. Rebuilding the same tree proves the reading.
  let args = e.args;
  let before: string | undefined;
  let after: string | undefined;
  if (args.length > 1 && isTextConst(args[0]!) && textSource(args[1]!)) {
    before = args[0]!.const;
    args = args.slice(1);
  }
  if (args.length > 1 && isTextConst(args[args.length - 1]!) && textSource(args[args.length - 2]!)) {
    after = (args[args.length - 1] as { const: string }).const;
    args = args.slice(0, -1);
  }
  const columns: string[] = [];
  let separator: string | undefined;
  for (const a of args) {
    const src = textSource(a);
    if (src) columns.push(src.col);
    else if (isTextConst(a)) separator ??= a.const;
    else return undefined;
  }
  if (columns.length < 2) return undefined;
  const method: ColumnMethod = {
    kind: 'join',
    columns,
    separator: separator ?? '',
    ...(before ? { before } : {}),
    ...(after ? { after } : {}),
  };
  return sameExpr(buildJoinExpr(columns, method.separator, typeOf, { ...(before ? { before } : {}), ...(after ? { after } : {}) }), e) ? method : undefined;
}

function readPart(e: Expr, typeOf: (id: string) => ValueType | undefined): ColumnMethod | undefined {
  if (!('op' in e) || e.op !== 'substr') return undefined;
  const src = textSource(e.arg);
  if (!src) return undefined;
  const part = e.start > 0 ? 'first' : 'last';
  const method: ColumnMethod = { kind: 'partOfText', source: src.col, part, n: e.length };
  return sameExpr(buildPartExpr(src.col, typeOf(src.col), part, e.length), e) ? method : undefined;
}

function readCopyWithTransforms(e: Expr, typeOf: (id: string) => ValueType | undefined): ColumnMethod | undefined {
  let cur = e;
  let padLeft: number | undefined;
  let trim = false;
  if ('op' in cur && cur.op === 'padLeft' && cur.char === '0') {
    padLeft = cur.length;
    cur = cur.arg;
  }
  if ('op' in cur && cur.op === 'trim') {
    trim = true;
    cur = cur.arg;
  }
  const src = textSource(cur);
  if (!src) return undefined;
  if (padLeft === undefined && !trim && !isLeafCol(e)) return undefined;
  const method: ColumnMethod = { kind: 'copy', source: src.col, ...(padLeft === undefined ? {} : { padLeft }), ...(trim ? { trim } : {}) };
  return sameExpr(buildCopyExpr(src.col, typeOf(src.col), { ...(padLeft === undefined ? {} : { padLeft }), trim }), e) ? method : undefined;
}

function pairsOf(vm: ValueMap): TranslatePair[] {
  return Object.entries(vm.map).map(([from, to]) => ({ from, to }));
}

/** What the editor shows for output column `index`. Never throws; a column it can't classify is `formula` (Advanced). */
export function readColumnMethod(rules: EditableRules, index: number): ColumnMethod | undefined {
  const outCol = rules.output.columns[index];
  if (!outCol) return undefined;
  if (outCol.from === null) return { kind: 'empty' };
  const id = outCol.from;
  const infos = idInfos(rules);
  const typeOf = (x: string): ValueType | undefined => infos.get(x)?.type;
  const vm = rules.transform.valueMaps.find((v) => v.column === id);
  const computed = rules.transform.computed.find((c) => c.id === id);

  if (!computed) {
    if (vm) return { kind: 'translate', source: id, pairs: pairsOf(vm), onMissing: vm.onMissing };
    const padLeft = rules.input.columns.find((c) => c.id === id)?.padLeft;
    return { kind: 'copy', source: id, ...(padLeft ? { padLeft } : {}) };
  }

  const e = computed.expr;
  if (vm && isLeafCol(e)) return { kind: 'translate', source: e.col, pairs: pairsOf(vm), onMissing: vm.onMissing };
  if (!vm) {
    if ('const' in e && e.const !== null) return { kind: 'fixed', value: e.const };
    if (isLeafCol(e)) return { kind: 'copy', source: e.col };
    const found = readCalc(e, typeOf) ?? readJoin(e, typeOf) ?? readPart(e, typeOf) ?? readCopyWithTransforms(e, typeOf);
    if (found) return found;
  }
  return { kind: 'formula', formula: printFormula(e), type: computed.type };
}

// ---------- validating a choice ----------

function unknownColumn(id: string, path: string): EditProblem {
  return { code: 'unknownColumn', message: `unknown column id "${id}"`, column: id, path };
}

function validateMethod(m: ColumnMethod, infos: ReturnType<typeof idInfos>): EditProblem[] {
  const problems: EditProblem[] = [];
  const need = (id: string, path: string): ValueType | undefined | 'missing' => {
    const info = infos.get(id);
    if (!info) {
      problems.push(unknownColumn(id, path));
      return 'missing';
    }
    return info.type;
  };
  switch (m.kind) {
    case 'empty':
      break;
    case 'copy':
      need(m.source, 'source');
      if (m.padLeft !== undefined && (!Number.isInteger(m.padLeft) || m.padLeft < 1 || m.padLeft > 99)) {
        problems.push({ code: 'badValue', message: 'padding must be a whole number from 1 to 99', path: 'padLeft' });
      }
      break;
    case 'calculate': {
      if (m.terms.length < 1) problems.push({ code: 'tooFewTerms', message: 'a calculation needs at least one term', path: 'terms' });
      if (m.terms.length > editorConfig.maxCalcTerms) {
        problems.push({ code: 'tooManyTerms', message: `a calculation has up to ${editorConfig.maxCalcTerms} terms`, path: 'terms' });
      }
      if (m.ops.length !== Math.max(0, m.terms.length - 1) || m.ops.some((o) => !(o in OP_NAME))) {
        problems.push({ code: 'badOperators', message: 'each pair of terms needs one of + - * /', path: 'ops' });
      }
      m.terms.forEach((t, i) => {
        if ('number' in t) {
          if (!Number.isFinite(t.number)) problems.push({ code: 'badValue', message: 'a term must be a number', path: `terms[${i}]` });
          return;
        }
        const type = need(t.column, `terms[${i}]`);
        if (type === 'missing' || type === undefined) return;
        const numeric = NUMERIC.has(type);
        const readable = t.toNumber === true && isTextLike(type);
        if (!numeric && !readable) {
          problems.push({ code: 'typeMismatch', message: mismatchMessage('decimal', type), path: `terms[${i}]`, column: t.column });
        }
      });
      if (m.round !== undefined && (!Number.isInteger(m.round) || m.round < 0 || m.round > 15)) {
        problems.push({ code: 'badValue', message: 'rounding is a whole number of decimals from 0 to 15', path: 'round' });
      }
      break;
    }
    case 'join':
      if (m.columns.length < 2) problems.push({ code: 'tooFewTerms', message: 'joining text needs at least two columns', path: 'columns' });
      m.columns.forEach((c, i) => need(c, `columns[${i}]`));
      break;
    case 'partOfText':
      need(m.source, 'source');
      if (!Number.isInteger(m.n) || m.n < 1 || m.n > 1000) {
        problems.push({ code: 'badValue', message: 'the number of characters must be a whole number of at least 1', path: 'n' });
      }
      break;
    case 'translate': {
      need(m.source, 'source');
      const seen = new Set<string>();
      m.pairs.forEach((p, i) => {
        if (p.from === '') problems.push({ code: 'badValue', message: 'the value to translate cannot be empty', path: `pairs[${i}].from` });
        else if (seen.has(p.from)) problems.push({ code: 'duplicateKey', message: `"${p.from}" is listed twice`, path: `pairs[${i}].from` });
        seen.add(p.from);
      });
      break;
    }
    case 'fixed':
      if (typeof m.value === 'number' && !Number.isFinite(m.value)) {
        problems.push({ code: 'badValue', message: 'a fixed number must be finite', path: 'value' });
      }
      break;
    case 'formula':
      break;
  }
  return problems;
}

// ---------- applying a choice ----------

/**
 * Sets how output column `index` is made. Reuses the computed column behind it when that column is its
 * own, makes a new one (generated id) otherwise, drops what nothing uses any more, and resolves the
 * column's "Needs your input" / "Please check" entries (the user has decided).
 */
export function applyColumnMethod(rules: EditableRules, index: number, method: ColumnMethod): Out {
  const outCol = rules.output.columns[index];
  if (!outCol) return fail({ code: 'noSuchItem', message: `there is no column ${index + 1}`, path: 'index' });

  const infos = idInfos(rules);
  const problems = validateMethod(method, infos);
  if (problems.length > 0) return problems;
  const typeOf = (id: string): ValueType | undefined => infos.get(id)?.type;

  const oldFrom = outCol.from;
  const own = ownedComputedId(rules, index);

  // The computed definition (and value map) this choice needs, if any.
  let from: string | null;
  let computed: { expr: Expr; type: ColumnType } | undefined;
  let valueMap: { column: 'self' | string; map: Record<string, string>; onMissing: 'flag' | 'keep' } | undefined;
  let inPlaceTranslate = false;

  switch (method.kind) {
    case 'empty':
      from = null;
      break;
    case 'copy': {
      const inputPad = rules.input.columns.find((c) => c.id === method.source)?.padLeft;
      const padLeft = method.padLeft !== undefined && method.padLeft === inputPad ? undefined : method.padLeft;
      // A value map on the source id would translate a plain copy too. A helper column reads the value before
      // the value maps run (SPEC 8.2 steps 6-7), so "copy" stays a copy of what the input says.
      const translatedElsewhere = rules.transform.valueMaps.some((v) => v.column === method.source);
      if (padLeft === undefined && !method.trim && !translatedElsewhere) {
        from = method.source;
      } else if (padLeft === undefined && !method.trim) {
        from = 'self';
        computed = { expr: col(method.source), type: declaredTypeOf(rules, method.source) };
      } else {
        from = 'self';
        computed = { expr: buildCopyExpr(method.source, typeOf(method.source), { ...(padLeft === undefined ? {} : { padLeft }), ...(method.trim ? { trim: true } : {}) }), type: 'text' };
      }
      break;
    }
    case 'calculate':
      from = 'self';
      computed = { expr: buildCalcExpr(method.terms, method.ops, method.round, typeOf), type: 'decimal' };
      break;
    case 'join':
      from = 'self';
      computed = { expr: buildJoinExpr(method.columns, method.separator, typeOf, { ...(method.before ? { before: method.before } : {}), ...(method.after ? { after: method.after } : {}) }), type: 'text' };
      break;
    case 'partOfText':
      from = 'self';
      computed = { expr: buildPartExpr(method.source, typeOf(method.source), method.part, method.n), type: 'text' };
      break;
    case 'fixed':
      from = 'self';
      computed = { expr: { const: method.value }, type: constType(method.value) };
      break;
    case 'translate': {
      const map = Object.fromEntries(method.pairs.map((p) => [p.from, p.to]));
      const existing =
        oldFrom !== null &&
        oldFrom === method.source &&
        !rules.transform.computed.some((c) => c.id === oldFrom) &&
        rules.transform.valueMaps.some((v) => v.column === oldFrom);
      if (existing) {
        // The learned shape: a value map right on the source id. Edit it where it is.
        from = method.source;
        inPlaceTranslate = true;
        valueMap = { column: method.source, map, onMissing: method.onMissing };
      } else {
        from = 'self';
        computed = { expr: col(method.source), type: declaredTypeOf(rules, method.source) };
        valueMap = { column: 'self', map, onMissing: method.onMissing };
      }
      break;
    }
    case 'formula': {
      const parsed = parseFormula(method.formula);
      if (!parsed.ok) {
        return fail({ code: 'formula', message: parsed.error.message, offset: parsed.error.offset, path: 'formula' });
      }
      from = 'self';
      const existingType = own === undefined ? undefined : rules.transform.computed.find((c) => c.id === own)?.type;
      computed = { expr: parsed.expr, type: method.type ?? existingType ?? 'text' };
      break;
    }
  }

  let next: EditableRules = rules;
  const touchedForPrune = new Set<string>();
  const dropValueMapsOf = new Set<string>();

  if (from === 'self') {
    const id = own ?? freshId(rules, prefixOf(method.kind));
    // What the reused helper used to read may be left with no reader.
    const oldDef = own === undefined ? undefined : rules.transform.computed.find((c) => c.id === own);
    if (oldDef) for (const ref of colRefs(oldDef.expr)) touchedForPrune.add(ref);
    const def: Computed = { id, type: computed!.type, expr: computed!.expr };
    const list = own === undefined ? [...rules.transform.computed, def] : rules.transform.computed.map((c) => (c.id === own ? def : c));
    // A value map on the reused id only survives when this choice brings its own.
    let valueMaps = rules.transform.valueMaps.filter((vm) => vm.column !== id);
    if (valueMap) valueMaps = [...valueMaps, { column: id, map: valueMap.map, onMissing: valueMap.onMissing }];
    next = { ...next, transform: { ...next.transform, computed: list, valueMaps } } as EditableRules;
    next = setFrom(next, index, id);
  } else {
    next = setFrom(next, index, from);
    if (inPlaceTranslate && valueMap) {
      const vmList = next.transform.valueMaps;
      const has = vmList.some((v) => v.column === valueMap!.column);
      const entry: ValueMap = { column: valueMap.column, map: valueMap.map, onMissing: valueMap.onMissing };
      next = { ...next, transform: { ...next.transform, valueMaps: has ? vmList.map((v) => (v.column === entry.column ? entry : v)) : [...vmList, entry] } } as EditableRules;
    }
  }

  // Clean up what the old choice left behind.
  if (oldFrom !== null && oldFrom !== (next.output.columns[index]?.from ?? null)) {
    touchedForPrune.add(oldFrom);
    dropValueMapsOf.add(oldFrom);
  }
  next = pruneComputed(next, touchedForPrune);
  next = pruneValueMaps(next, dropValueMapsOf);

  // The user has decided this column: its "Needs your input" and "Please check" entries are resolved.
  const header = outCol.header;
  next = {
    ...next,
    unsupported: next.unsupported.filter((u) => u.outputColumn !== header),
    assumptions: next.assumptions.filter((a) => a.outputColumn !== header),
  } as EditableRules;
  return next;
}

/** The declared column type of an id, for a computed column that just copies it. */
function declaredTypeOf(rules: EditableRules, id: string): ColumnType {
  const input = rules.input.columns.find((c) => c.id === id);
  if (input) return input.type;
  const computed = rules.transform.computed.find((c) => c.id === id);
  if (computed) return computed.type;
  const t = idInfos(rules).get(id)?.type;
  return t === undefined ? 'text' : t;
}

function prefixOf(kind: ColumnMethod['kind']): string {
  switch (kind) {
    case 'calculate':
      return 'calc';
    case 'join':
      return 'join';
    case 'partOfText':
      return 'part';
    case 'fixed':
      return 'fixed';
    case 'translate':
      return 'tr';
    case 'copy':
      return 'copy';
    default:
      return 'expr';
  }
}

function setFrom(rules: EditableRules, index: number, from: string | null): EditableRules {
  return { ...rules, output: { ...rules.output, columns: rules.output.columns.map((c, i) => (i === index ? { ...c, from } : c)) } } as EditableRules;
}

/** Input/expand ids an output column's method reads, for "what is this column based on". */
export function methodSources(method: ColumnMethod): string[] {
  switch (method.kind) {
    case 'copy':
    case 'partOfText':
    case 'translate':
      return [method.source];
    case 'join':
      return [...method.columns];
    case 'calculate':
      return method.terms.flatMap((t) => ('column' in t ? [t.column] : []));
    case 'formula': {
      const parsed = parseFormula(method.formula);
      return parsed.ok ? [...colRefs(parsed.expr)] : [];
    }
    default:
      return [];
  }
}

/** Is `id` still read by anything? (used by callers deciding whether a source may be removed) */
export function isReferenced(rules: EditableRules, id: string): boolean {
  return referencedIds(rules).has(id);
}

