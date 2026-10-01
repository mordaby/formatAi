// SPEC 9.2 "Checking what the LLM wrote": the layers, in order, that turn a raw LLM
// response into either a usable rules file or a precise list of `RepairProblem`s for
// the next repair call. Layers 1-5 (structure/references/types/limits/format lock) are
// gates: layer 2 onward only runs once the layers before it produced a parseable
// object, and layer 7 ("run on the samples") only runs once every gate is clean,
// because `runRules` itself refuses to execute rules `checkRules` (layer 2) rejects
// (see `packages/engine/src/pipeline/runRules.ts`) - running it earlier would only
// ever report a single generic rejection on top of the precise problems already
// collected. Layer 6 (the overfitting lint) is never a gate: it always runs and always
// appends its findings to the returned rules' `assumptions`, regardless of what else
// failed, since it costs nothing and the caller may still show this attempt to a human.
import { checkFixedLock, checkFormatLock, checkLimits, completionProduced, formulaRulesFromWire, printFormula, typeCheck } from '@formatai/engine';
import {
  checkRules,
  fromWire,
  LearnResultSchema,
  type CompletePayload,
  type Expr,
  type Format,
  type LearnResult,
  type ProfileType,
  type RepairProblem,
  type RuleProblem,
  type LearnPayload,
  type Tier,
} from '@formatai/shared';
import { overfitLint } from './overfitLint.js';
import { runOnSamples } from './sampleRun.js';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function looksLikeExpr(v: unknown): v is Expr {
  return isRecord(v) && ('col' in v || 'const' in v || 'param' in v || 'op' in v);
}

/** Dotted/bracketed path ("transform.computed[1].expr.args[0]") -> the value there, or
 * `undefined` if any segment doesn't resolve. Used only to look up a sub-expression for
 * `quoteExprInMessage` below - never throws on a malformed/out-of-range path. */
function getAtPath(root: unknown, path: string): unknown {
  const tokens = path.match(/[^.[\]]+/g) ?? [];
  let cur: unknown = root;
  for (const t of tokens) {
    if (cur == null) return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(t);
      cur = Number.isInteger(idx) ? cur[idx] : undefined;
    } else if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[t];
    } else {
      return undefined;
    }
  }
  return cur;
}

/**
 * SPEC 9.3: a repair message is only actionable if the model can see what it wrote.
 * `typeCheck`/`checkLimits` report a dotted path into the rules tree, not the
 * expression itself - this resolves that path against the already-parsed `rules` (real
 * Expr trees, learn-v5) and appends the offending sub-expression as formula TEXT (the
 * same notation the model itself writes), so a `type`/`limit` repair problem reads like
 * `"expected decimal, got text; use toNumber (in: round(amount, 2))"` instead of only
 * naming a path the model has no way to resolve on its own.
 */
function quoteExprInMessage(rules: LearnResult, path: string, message: string): string {
  const node = getAtPath(rules, path);
  if (!looksLikeExpr(node)) return message;
  try {
    return `${message} (in: ${printFormula(node)})`;
  } catch {
    return message;
  }
}

export interface ChecksOptions {
  tier: Tier;
}

export interface ChecksResult {
  problems: RepairProblem[];
  /** The parsed `LearnResult`, with any overfitting-lint findings appended to
   * `assumptions` (SPEC 9.2 layer 6) - or `null` when layer 1 (structure) itself
   * failed, since there is then no valid object to return at all. */
  rules: LearnResult | null;
}

/**
 * Completion mode: `payload.complete.fixed` (wire form, constants masked when masking is on) read back into a real
 * `LearnResult` - the same steps an answer goes through (pairs -> records, formula text -> trees, zod). `null` when it
 * cannot be read: the route refuses such a payload (`invalidPayload`) before any call is made.
 */
export function readCompleteFixed(complete: Pick<CompletePayload, 'fixed'>): LearnResult | null {
  const { rules, problems } = formulaRulesFromWire(fromWire(complete.fixed));
  if (problems.length > 0) return null;
  const parsed = LearnResultSchema.safeParse(rules);
  return parsed.success ? parsed.data : null;
}

function ruleProblemToRepairProblem(p: RuleProblem): RepairProblem {
  // RuleProblem's sub-kinds (reference/depth/duplicateId/arity) are all SPEC 9.2
  // layer 2 "References" - RepairProblem has one `reference` kind for the whole
  // layer, with no separate `path` field, so the path is folded into the message.
  return { kind: 'reference', message: p.path ? `${p.path}: ${p.message}` : p.message };
}

/** SPEC 9.2 layer 2, beyond `checkRules` (which only checks references *within* the
 * rules file): every declared input header must actually exist in the payload (the
 * LLM is told to copy headers exactly, LEARN_PROMPT "Languages and direction"), and
 * `from: null` must appear EXACTLY on `skipColumns` ∪ `unsupported` - never more,
 * never less (LEARN_PROMPT: "Do not list them in unsupported; they are already
 * reported", and SPEC 8.10: an unsupported column "has `from: null`"). */
function extraReferenceProblems(rules: LearnResult, payload: LearnPayload): RepairProblem[] {
  const problems: RepairProblem[] = [];

  const payloadHeaders = new Set(payload.input.columns.map((c) => c.header));
  for (const col of rules.input.columns) {
    if (!payloadHeaders.has(col.header)) {
      problems.push({
        kind: 'reference',
        message: `input column "${col.id}" has header "${col.header}", which does not exist in the payload`,
      });
    }
  }

  const outputHeaderAt = new Map(payload.output.columns.map((c) => [c.i, c.header] as const));
  const mustBeNull = new Set<string>();
  for (const i of payload.skipColumns ?? []) {
    const header = outputHeaderAt.get(i);
    if (header !== undefined) mustBeNull.add(header);
  }
  for (const u of rules.unsupported) mustBeNull.add(u.outputColumn);
  // Completion mode: a listed column with no `from` and no `unsupported` entry is reported, more precisely, by the fixed lock.
  const listed = new Set<string>();
  for (const i of payload.complete?.columns ?? []) {
    const header = outputHeaderAt.get(i);
    if (header !== undefined) listed.add(header);
  }

  for (const col of rules.output.columns) {
    const shouldBeNull = mustBeNull.has(col.header);
    const isNull = col.from === null;
    if (shouldBeNull && !isNull) {
      problems.push({
        kind: 'reference',
        message: `output column "${col.header}" is in skipColumns or unsupported, so "from" must be null`,
      });
    } else if (!shouldBeNull && isNull && !listed.has(col.header)) {
      problems.push({
        kind: 'reference',
        message: `output column "${col.header}" has "from": null but is not in skipColumns or unsupported`,
      });
    }
  }

  return problems;
}

function toProfileType(t: ProfileType): string {
  return t;
}

/** Runs every SPEC 9.2 layer, in order, on one raw (wire-shaped) LLM response. */
export function runChecks(rawJson: unknown, payload: LearnPayload, opts: ChecksOptions): ChecksResult {
  // ----- Layer 0: formula text -> Expr trees (learn-v5) -----
  // `fromWire` (shared) turns the `{key,value}[]` pairs back into records; the four Expr
  // positions inside are still formula TEXT at that point (the wire schema never had an
  // Expr sub-schema, SPEC 8.3/`wire.ts`) - `formulaRulesFromWire` (engine) parses them.
  // A formula that fails to parse is left as a string and reported as its own `formula`
  // problem (with an offset INTO that formula, for tracking how often models write
  // invalid formulas); this attempt stops here, same as layer 1 below, since there's no
  // point running reference/type/limit checks against a tree that still has raw text
  // sitting where an Expr belongs.
  // Operations the prompt does not document yet (`inPrompt: false` in the engine's OP_SIGNATURES:
  // weekday, makeDate, toDate, date, keepChars, titleCase, find) are unknown functions here: the
  // model was never told about them, so it cannot use them (until the prompt version that ships
  // them). Completion mode is the one exception: `complete.fixed` is the user's own rules, which may
  // already use them, and the answer must copy it unchanged.
  const { rules: formulaDecoded, problems: formulaProblems } = formulaRulesFromWire(fromWire(rawJson), {
    promptOpsOnly: payload.complete === undefined,
  });
  if (formulaProblems.length > 0) {
    return { problems: formulaProblems, rules: null };
  }

  // ----- Layer 1: structure -----
  const parsed = LearnResultSchema.safeParse(formulaDecoded);
  if (!parsed.success) {
    const problems: RepairProblem[] = parsed.error.issues.map((issue) => ({
      kind: 'schema',
      path: issue.path.map(String).join('.'),
      message: issue.message,
    }));
    return { problems, rules: null };
  }

  const rules: LearnResult = parsed.data;
  const problems: RepairProblem[] = [];

  // ----- Layer 2: references -----
  problems.push(...checkRules(rules).map(ruleProblemToRepairProblem));
  problems.push(...extraReferenceProblems(rules, payload));

  // ----- Layer 3: types -----
  const inputProfile = payload.input.columns.map((c) => ({ header: c.header, type: toProfileType(c.type) }));
  const outputTypes: Record<string, string> = {};
  for (const c of payload.output.columns) outputTypes[c.header] = toProfileType(c.type);
  problems.push(
    ...typeCheck(rules, { inputProfile, outputTypes }).map(
      (p): RepairProblem => ({ kind: 'type', path: p.path, message: quoteExprInMessage(rules, p.path, p.message) }),
    ),
  );

  // ----- Layer 4: limits and safety -----
  problems.push(
    ...checkLimits(rules, opts.tier).map(
      (p): RepairProblem => ({
        kind: 'limit',
        path: p.path,
        message: p.path ? quoteExprInMessage(rules, p.path, p.message) : p.message,
      }),
    ),
  );

  // ----- Layer 5: format lock (attach mode only; completion mode has its own, 5b below) -----
  if (payload.target) {
    const format: Format = {
      output: payload.target.output,
      layout: payload.target.layout,
      outputValidations: payload.target.validations,
    };
    problems.push(
      ...checkFormatLock(rules, format).map(
        (p): RepairProblem => ({ kind: 'formatMismatch', path: p.path, message: p.message }),
      ),
    );
  }

  // ----- Layer 5b: fixed lock (completion mode only) -----
  // Both sides are still in the vocabulary of this payload (masked when masking is on), so they compare as they are.
  if (payload.complete) {
    const fixed = readCompleteFixed(payload.complete);
    if (fixed) {
      const asked = { columns: payload.complete.columns, parts: payload.complete.parts };
      problems.push(
        ...checkFixedLock(rules, fixed, asked).map((p): RepairProblem => ({ kind: 'fixedMismatch', path: p.path, message: p.message })),
      );
      // Reporting every listed column as unsupported and building no listed part is clean for the lock, but it is no completion.
      const produced = completionProduced(rules, fixed, asked);
      if ((asked.columns.length > 0 || asked.parts.length > 0) && produced.columns === 0 && produced.parts === 0) {
        problems.push({
          kind: 'fixedMismatch',
          path: 'output.columns',
          message: 'nothing that complete lists was produced: give at least one column of complete.columns a "from" (or build one of complete.parts), and report only what really cannot be produced as unsupported',
        });
      }
    }
  }

  // ----- Layer 5c: something has to be produced (plain learn only; completion mode has its own, 5b above) -----
  // A column honestly reported as unsupported is no problem (layer 7 leaves it out of the comparison), but a file in which EVERY column is
  // is no learn: no value is produced at all. It is not "verified", however clean the rest.
  if (!payload.complete && rules.output.columns.length > 0 && rules.output.columns.every((c) => c.from === null)) {
    problems.push({
      kind: 'reference',
      message: 'every output column has "from": null (reported as unsupported), so the rules produce no value at all: give a "from" to every column that can be produced from the input, and report only what really cannot be produced as unsupported',
    });
  }

  // ----- Layer 6: overfitting lint (never a rejection) -----
  const lintAssumptions = overfitLint(rules, payload);
  const rulesWithLint: LearnResult =
    lintAssumptions.length > 0 ? { ...rules, assumptions: [...rules.assumptions, ...lintAssumptions] } : rules;

  // ----- Layer 7: run on the samples (only once every gate above is clean) -----
  // (A column reported as unsupported - `from: null` plus an entry - is left out of the diff: nothing to compare, nothing to repair.)
  if (problems.length === 0) {
    problems.push(...runOnSamples(rulesWithLint, payload));
  }

  return { problems, rules: rulesWithLint };
}
