// Code checks that go beyond what zod can express (SPEC 9.2): every referenced
// column id exists at the pipeline step where it's used, ids are unique and
// expand-created ids don't collide, and expression nesting depth <= 6 (SPEC 8.3).
//
// Engine pipeline order (SPEC 8.2 / LEARN_PROMPT "Operations"):
//   read -> rowFilters -> dedupe -> expand -> computed -> valueMaps -> sort -> group -> output -> validations
import type { Expr, LearnResult, Rules } from './schema';

export type RuleProblemKind = 'reference' | 'depth' | 'duplicateId';

export interface RuleProblem {
  kind: RuleProblemKind;
  /** Dotted/bracketed path to the offending field, e.g. "transform.computed[0].expr". */
  path: string;
  message: string;
}

const MAX_EXPR_DEPTH = 6;

/** Every direct child Expr of a node (leaves have none). */
function exprChildren(e: Expr): Expr[] {
  if ('col' in e || 'const' in e) return [];
  switch (e.op) {
    case 'add':
    case 'sub':
    case 'mul':
    case 'div':
    case 'concat':
    case 'coalesce':
    case 'and':
    case 'or':
      return e.args;
    case 'eq':
    case 'ne':
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      return e.args;
    case 'neg':
    case 'abs':
    case 'round':
    case 'substr':
    case 'trim':
    case 'upper':
    case 'lower':
    case 'replaceText':
    case 'padLeft':
    case 'datePart':
    case 'dateFormat':
    case 'isEmpty':
    case 'notEmpty':
    case 'not':
      return [e.arg];
    case 'if':
      return [e.cond, e.then, e.else];
  }
}

function exprDepth(e: Expr): number {
  const children = exprChildren(e);
  if (children.length === 0) return 1;
  return 1 + Math.max(...children.map(exprDepth));
}

function collectColRefs(e: Expr, out: string[]): void {
  if ('col' in e) {
    out.push(e.col);
    return;
  }
  if ('const' in e) return;
  for (const child of exprChildren(e)) collectColRefs(child, out);
}

function checkExpr(
  expr: Expr,
  available: ReadonlySet<string>,
  path: string,
  problems: RuleProblem[],
): void {
  const refs: string[] = [];
  collectColRefs(expr, refs);
  for (const id of refs) {
    if (!available.has(id)) {
      problems.push({ kind: 'reference', path, message: `unknown column id "${id}"` });
    }
  }
  const depth = exprDepth(expr);
  if (depth > MAX_EXPR_DEPTH) {
    problems.push({
      kind: 'depth',
      path,
      message: `expression nesting depth ${depth} exceeds the maximum of ${MAX_EXPR_DEPTH}`,
    });
  }
}

function checkRef(
  id: string,
  available: ReadonlySet<string>,
  path: string,
  problems: RuleProblem[],
): void {
  if (!available.has(id)) {
    problems.push({ kind: 'reference', path, message: `unknown column id "${id}"` });
  }
}

function addNewId(
  id: string,
  existing: ReadonlySet<string>,
  newlyAdded: Set<string>,
  path: string,
  problems: RuleProblem[],
): void {
  if (existing.has(id) || newlyAdded.has(id)) {
    problems.push({
      kind: 'duplicateId',
      path,
      message: `id "${id}" collides with an existing column id`,
    });
  } else {
    newlyAdded.add(id);
  }
}

/**
 * Validates cross-references, id uniqueness/collisions and expression depth in
 * an already schema-valid LearnResult/Rules object. Complements zod validation;
 * it does not re-check shapes zod already enforces.
 */
export function checkRules(rules: LearnResult | Rules): RuleProblem[] {
  const problems: RuleProblem[] = [];

  // ----- Step 0: input column ids must be unique -----
  const inputIds = new Set<string>();
  rules.input.columns.forEach((col, i) => {
    if (inputIds.has(col.id)) {
      problems.push({
        kind: 'duplicateId',
        path: `input.columns[${i}].id`,
        message: `duplicate column id "${col.id}"`,
      });
    } else {
      inputIds.add(col.id);
    }
  });

  // ----- Step 1: rowFilters (against ids from read) -----
  rules.input.rowFilters?.forEach((f, i) => {
    checkRef(f.column, inputIds, `input.rowFilters[${i}].column`, problems);
  });

  // ----- Step 2: dedupe (against ids from read, before expand) -----
  if (rules.transform.dedupe) {
    const { keys } = rules.transform.dedupe;
    if (keys !== 'all') {
      keys.forEach((k, i) => checkRef(k, inputIds, `transform.dedupe.keys[${i}]`, problems));
    }
  }

  // ----- Step 3: expand -----
  const afterExpand = new Set(inputIds);
  const newIdsFromExpand = new Set<string>();

  if (rules.transform.expand) {
    const ex = rules.transform.expand;
    if (ex.mode === 'columnsToRows') {
      ex.columns.forEach((c, i) =>
        checkRef(c, inputIds, `transform.expand.columns[${i}]`, problems),
      );
      // SPEC 8.5: "The listed columns aren't available after this step."
      for (const c of ex.columns) afterExpand.delete(c);

      addNewId(ex.labelId, afterExpand, newIdsFromExpand, 'transform.expand.labelId', problems);
      addNewId(ex.valueId, afterExpand, newIdsFromExpand, 'transform.expand.valueId', problems);
      afterExpand.add(ex.labelId);
      afterExpand.add(ex.valueId);
    } else if (ex.mode === 'splitCell') {
      checkRef(ex.column, inputIds, 'transform.expand.column', problems);

      addNewId(ex.partId, afterExpand, newIdsFromExpand, 'transform.expand.partId', problems);
      afterExpand.add(ex.partId);
      if (ex.indexId) {
        addNewId(
          ex.indexId,
          afterExpand,
          newIdsFromExpand,
          'transform.expand.indexId',
          problems,
        );
        afterExpand.add(ex.indexId);
      }
      if (ex.countId) {
        addNewId(
          ex.countId,
          afterExpand,
          newIdsFromExpand,
          'transform.expand.countId',
          problems,
        );
        afterExpand.add(ex.countId);
      }
    } else {
      // fixedFanOut: "set creates or overwrites columns for that row" - overwriting
      // an existing id is explicitly allowed, so no collision check here, only
      // reference/depth checks on the expressions (checked against pre-expand ids,
      // since fixedFanOut runs directly on the read+filtered+deduped row).
      ex.rows.forEach((row, ri) => {
        for (const [id, expr] of Object.entries(row.set)) {
          checkExpr(expr, inputIds, `transform.expand.rows[${ri}].set.${id}`, problems);
          afterExpand.add(id);
        }
      });
    }
  }

  // ----- Step 4: computed (sequential; may reference earlier computed ids) -----
  const availableForComputed = new Set(afterExpand);
  rules.transform.computed.forEach((c, i) => {
    checkExpr(c.expr, availableForComputed, `transform.computed[${i}].expr`, problems);
    if (availableForComputed.has(c.id)) {
      problems.push({
        kind: 'duplicateId',
        path: `transform.computed[${i}].id`,
        message: `id "${c.id}" collides with an existing column id`,
      });
    } else {
      availableForComputed.add(c.id);
    }
  });

  // Ids available from here on (valueMaps, sort, group, output, validations).
  const finalIds = availableForComputed;

  // ----- Step 5: valueMaps -----
  rules.transform.valueMaps.forEach((vm, i) => {
    checkRef(vm.column, finalIds, `transform.valueMaps[${i}].column`, problems);
  });

  // ----- Step 6: sort -----
  rules.transform.sort.forEach((s, i) => {
    checkRef(s.column, finalIds, `transform.sort[${i}].column`, problems);
  });

  // ----- Step 7: group -----
  if (rules.transform.group) {
    const g = rules.transform.group;
    checkRef(g.by, finalIds, 'transform.group.by', problems);
    if (g.subtotal) {
      checkRef(g.subtotal.labelColumn, finalIds, 'transform.group.subtotal.labelColumn', problems);
      g.subtotal.sum.forEach((id, i) =>
        checkRef(id, finalIds, `transform.group.subtotal.sum[${i}]`, problems),
      );
    }
  }

  // ----- Step 8: output -----
  rules.output.columns.forEach((col, i) => {
    if (col.from !== null) {
      checkRef(col.from, finalIds, `output.columns[${i}].from`, problems);
    }
  });
  rules.output.titleRows.forEach((tr, i) => {
    if ('parts' in tr) {
      tr.parts.forEach((p, pi) => {
        if ('agg' in p) {
          checkRef(p.column, finalIds, `output.titleRows[${i}].parts[${pi}].column`, problems);
        }
      });
    }
  });
  if (rules.output.grandTotal) {
    checkRef(rules.output.grandTotal.labelColumn, finalIds, 'output.grandTotal.labelColumn', problems);
    rules.output.grandTotal.sum.forEach((id, i) =>
      checkRef(id, finalIds, `output.grandTotal.sum[${i}]`, problems),
    );
  }

  // ----- Step 9: validations -----
  rules.validations.forEach((v, i) => {
    checkRef(v.column, finalIds, `validations[${i}].column`, problems);
  });

  return problems;
}
