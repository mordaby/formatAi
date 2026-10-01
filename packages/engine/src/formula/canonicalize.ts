// Canonical form for an `Expr` tree, used by the round-trip property test
// (`formulaRulesFromWire(formulaRulesToWire(r))` should deep-equal `canonicalizeRules(r)`
// - see `test/formula/formulaRules.roundtrip.test.ts`).
//
// The one place `printFormula`+`parseFormula` can't reproduce an arbitrary hand-authored
// tree byte-for-byte is a LEADING same-op child of `add`/`sub`/`mul`/`div`
// (`{op:'add',args:[{op:'add',args:[a,b]},c]}` prints identically to the already-flat
// `{op:'add',args:[a,b,c]}` - both as "a + b + c" - because +/- and */÷ are genuinely
// associative in this engine, SPEC 8.3/`pipeline/v1/expr.ts`'s `compileArith`: a
// left-to-right reduce over the whole `args` array). Flattening that leading child is
// exactly what printing-then-reparsing does, so this is that same, semantics-preserving
// flattening applied directly to the tree - never crossing DIFFERENT ops together, and
// never touching a NON-leading child, both of which round-trip exactly as written
// already (see `printFormula.ts`'s header comment).
import type { Expand, Expr, ExprNode, LearnResult, RulesTransform } from '@formatai/shared';

function isExprNode(e: Expr): e is ExprNode {
  return 'op' in e;
}

type ArithOp = 'add' | 'sub' | 'mul' | 'div';

function flattenSameOp(op: ArithOp, args: readonly Expr[]): Expr[] {
  let out = args.slice();
  for (;;) {
    const first = out[0];
    if (first && isExprNode(first) && first.op === op) {
      out = [...(first as Extract<ExprNode, { op: ArithOp }>).args, ...out.slice(1)];
    } else {
      break;
    }
  }
  return out;
}

export function canonicalizeExpr(e: Expr): Expr {
  if (!isExprNode(e)) return e;
  switch (e.op) {
    case 'add':
    case 'sub':
    case 'mul':
    case 'div':
      return { op: e.op, args: flattenSameOp(e.op, e.args.map(canonicalizeExpr)) } as Expr;
    case 'neg':
    case 'abs':
    case 'floor':
    case 'ceil':
    case 'round':
    case 'trim':
    case 'upper':
    case 'lower':
    case 'length':
    case 'toNumber':
    case 'toText':
    case 'datePart':
    case 'dateFormat':
    case 'dateAdd':
    case 'endOfMonth':
    case 'weekday':
    case 'toDate':
    case 'keepChars':
    case 'titleCase':
    case 'find':
    case 'isEmpty':
    case 'notEmpty':
    case 'not':
    case 'substr':
    case 'padLeft':
    case 'split':
    case 'replaceText':
    case 'oneOf':
    case 'startsWith':
    case 'endsWith':
    case 'contains':
      return { ...e, arg: canonicalizeExpr(e.arg) } as Expr;
    case 'mod':
    case 'dateDiff':
    case 'eq':
    case 'ne':
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      return { ...e, args: [canonicalizeExpr(e.args[0]), canonicalizeExpr(e.args[1])] } as Expr;
    case 'makeDate':
      return { ...e, args: [canonicalizeExpr(e.args[0]), canonicalizeExpr(e.args[1]), canonicalizeExpr(e.args[2])] } as Expr;
    case 'dateLiteral':
      return e;
    case 'min':
    case 'max':
    case 'concat':
    case 'coalesce':
    case 'and':
    case 'or':
      return { ...e, args: e.args.map(canonicalizeExpr) } as Expr;
    case 'if':
      return { op: 'if', cond: canonicalizeExpr(e.cond), then: canonicalizeExpr(e.then), else: canonicalizeExpr(e.else) };
    case 'switch':
      return {
        op: 'switch',
        cases: e.cases.map((c) => ({ when: canonicalizeExpr(c.when), then: canonicalizeExpr(c.then) })),
        else: canonicalizeExpr(e.else),
      };
    case 'lookup':
      return { ...e, key: canonicalizeExpr(e.key) };
    case 'call':
      return { ...e, args: e.args.map(canonicalizeExpr) };
    default: {
      const never: never = e;
      throw new Error(`canonicalizeExpr: unhandled op ${JSON.stringify(never)}`);
    }
  }
}

function canonicalizeExpand(expand: Expand | undefined): Expand | undefined {
  if (!expand) return undefined;
  if (expand.mode !== 'fixedFanOut') return expand;
  return {
    ...expand,
    rows: expand.rows.map((row) => {
      const set: Record<string, Expr> = {};
      for (const [id, e] of Object.entries(row.set)) set[id] = canonicalizeExpr(e);
      return { set };
    }),
  };
}

function canonicalizeTransform(transform: RulesTransform): RulesTransform {
  return {
    ...transform,
    computed: transform.computed.map((c) => ({ ...c, expr: canonicalizeExpr(c.expr) })),
    expand: canonicalizeExpand(transform.expand),
    functions: transform.functions?.map((fn) => ({ ...fn, body: canonicalizeExpr(fn.body) })),
  };
}

/** Canonicalizes every expression position in a `LearnResult`/`Rules` tree (SPEC 8.3's
 * four Expr positions: `computed[].expr`, `rowFilters[].expr`, `fixedFanOut` set values,
 * `functions[].body`). Preserves every other field (including `name`/`meta` on a stored
 * `Rules`) via the `T` generic, matching `wire.ts`'s `toWire<T>` pattern. */
export function canonicalizeRules<T extends LearnResult>(rules: T): T {
  return {
    ...rules,
    input: {
      ...rules.input,
      rowFilters: rules.input.rowFilters?.map((f) => ('expr' in f ? { ...f, expr: canonicalizeExpr(f.expr) } : f)),
    },
    transform: canonicalizeTransform(rules.transform),
  } as T;
}
