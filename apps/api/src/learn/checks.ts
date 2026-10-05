// SPEC 9.2 "Checking what the LLM wrote": the layers, in order, that turn a raw LLM
// response into either a usable rules file or a precise list of `RepairProblem`s for
// the next repair call. Layers 1-5 (structure/references/types/limits/format lock) are
// gates: layer 2 onward only runs once the layers before it produced a parseable
// object, and layer 7 ("run on the samples") only runs once every gate is clean,
// because `runRules` itself refuses to execute rules `checkRules` (layer 2) rejects
// (see `packages/engine/src/pipeline/runRules.ts`) - running it earlier would only
// ever report a single generic rejection on top of the precise problems already
// collected. Layer 6 has two parts. The overfitting guards (6a: a condition on a row's position,
// a long list of one-row cases, a lookup keyed on an amount) find a rule that copies rows of the example: an `overfit` problem
// for one repair, or - once the learn had that repair - the column reported unsupported by code.
// The overfitting lint (6b) is never a gate: it always runs and always appends its findings to
// the returned rules' `assumptions`, regardless of what else failed, since it costs nothing and
// the caller may still show this attempt to a human.
// In completion mode an answer that broke the fixed lock has the fixed parts put back by code
// first (`restoreFixed`), and every layer runs again on that.
import { checkFixedLock, checkFormatLock, checkLimits, completionProduced, formulaRulesFromWire, overfitFindings, overfitProblems, printFormula, restoreFixed, typeCheck, withOverfitFallback } from '@formatai/engine';
import {
  checkRules,
  fromWire,
  LearnAlternativeSchema,
  LearnResultSchema,
  limits,
  splitAlternatives,
  type CompletePayload,
  type LearnAlternative,
  type Expr,
  type Format,
  type LearnResult,
  type ProfileType,
  type RepairProblem,
  type RuleProblem,
  type LearnPayload,
  type Tier,
  unsupportedDespiteEvidence,
} from '@formatai/shared';
import { dropInvalidNotes } from './notes.js';
import { overfitLint } from './overfitLint.js';
import { buildSampleInputTable, runOnSamples } from './sampleRun.js';

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
  /** Whether the answer may give `alternatives` (learn-v8 and later; default true). With false (learn-v7) any it gives is dropped. */
  alternatives?: boolean;
  /**
   * What a rule that copies particular rows of the example becomes (layer 6, the overfitting guards): `repair` (the default) - an `overfit`
   * problem for the column, so a repair call is asked for a rule that holds for any row; `fallBack` - the learn already had its one repair
   * for it (`learn.ts`), so code reports the column as unsupported (reason `overfit`, "needs your input") and the answer is checked without it.
   */
  overfit?: 'repair' | 'fallBack';
}

export interface ChecksResult {
  problems: RepairProblem[];
  /** The parsed `LearnResult`, with any overfitting-lint findings appended to
   * `assumptions` (SPEC 9.2 layer 6) - or `null` when layer 1 (structure) itself
   * failed, since there is then no valid object to return at all. */
  rules: LearnResult | null;
  /** learn-v8: the answer's alternatives that passed their own checks (Expr trees, in the answer's own vocabulary). Never part of `rules`. */
  alternatives: LearnAlternative[];
  /** How many alternatives the answer gave that were dropped (see `checkAlternatives`) - for the call record's `problemCounts`. */
  invalidAlternatives: number;
  /** `overfit: 'fallBack'`: how many output columns code reported as unsupported because their rule copied rows - for `problemCounts`. */
  overfitFallbacks: number;
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

/**
 * Runs every SPEC 9.2 layer, in order, on one raw (wire-shaped) LLM response. learn-v8: the answer's `alternatives` are taken off first,
 * so the answer is checked exactly as before (and an alternative can never cause a repair of it); each is then checked on its own against
 * the checked answer (`checkAlternatives`).
 */
export function runChecks(rawJson: unknown, payload: LearnPayload, opts: ChecksOptions): ChecksResult {
  const { answer, alternatives } = splitAlternatives(rawJson);
  const checked = checkAnswer(answer, payload, opts);
  if (alternatives === undefined || alternatives.length === 0) return { ...checked, alternatives: [], invalidAlternatives: 0 };
  // DECISION: an answer that did not even parse has nothing to swap an alternative into: they are not checked and not counted (the repair
  // round's answer gives its own).
  if (checked.rules === null) return { ...checked, alternatives: [], invalidAlternatives: 0 };
  return { ...checked, ...checkAlternatives(alternatives, checked.rules, payload, opts) };
}

type Checked = Pick<ChecksResult, 'problems' | 'rules' | 'overfitFallbacks'>;

function checkAnswer(rawJson: unknown, payload: LearnPayload, opts: ChecksOptions): Checked {
  // ----- Layer 0: formula text -> Expr trees (learn-v5) -----
  // `fromWire` (shared) turns the `{key,value}[]` pairs back into records; the four Expr
  // positions inside are still formula TEXT at that point (the wire schema never had an
  // Expr sub-schema, SPEC 8.3/`wire.ts`) - `formulaRulesFromWire` (engine) parses them.
  // A formula that fails to parse is left as a string and reported as its own `formula`
  // problem (with an offset INTO that formula, for tracking how often models write
  // invalid formulas); this attempt stops here, same as layer 1 below, since there's no
  // point running reference/type/limit checks against a tree that still has raw text
  // sitting where an Expr belongs.
  // Operations the prompt does not document (an op flagged `inPrompt: false` in the engine's OP_SIGNATURES) would be unknown
  // functions here: the model was never told about them, so it cannot use them. learn-v7 documents every op, so none is held back
  // today; the mechanism stays for the next op added before its prompt version. Completion mode is the one exception:
  // `complete.fixed` is the user's own rules, which may already use them, and the answer must copy it unchanged.
  const { rules: formulaDecoded, problems: formulaProblems } = formulaRulesFromWire(fromWire(rawJson), {
    promptOpsOnly: payload.complete === undefined,
  });
  if (formulaProblems.length > 0) {
    return { problems: formulaProblems, rules: null, overfitFallbacks: 0 };
  }

  // ----- Layer 1: structure -----
  // learn-v7: the optional notes of an unsupported entry (functionRequest, explanation) are extras: one that breaks its limits is dropped
  // here, so it can never fail or repair a learn (`notes.ts`). The strict schema still checks everything else, notes included.
  const parsed = LearnResultSchema.safeParse(dropInvalidNotes(formulaDecoded));
  if (!parsed.success) {
    const problems: RepairProblem[] = parsed.error.issues.map((issue) => ({
      kind: 'schema',
      path: issue.path.map(String).join('.'),
      message: issue.message,
    }));
    return { problems, rules: null, overfitFallbacks: 0 };
  }

  const first = checkParsed(parsed.data, payload, opts);

  // ----- Completion mode: fixed parts put back by code (docs/proposals/learning-loop.md 3.2) -----
  // An answer that changed or dropped part of the rules it had to keep (layer 5b's `fixedMismatch`) can never be used as it is: code puts
  // those parts back from `complete.fixed` (`restoreFixed`) and every layer runs again on the result, which is this attempt from then on.
  // The checks still decide: what code cannot put back (a new value map on a column a fixed output column reads, a listed column with no
  // rule) is still a `fixedMismatch` for a repair round, and so is anything the restored rules now fail.
  if (payload.complete && first.problems.some((p) => p.kind === 'fixedMismatch')) {
    const fixed = readCompleteFixed(payload.complete);
    const restored = fixed ? LearnResultSchema.safeParse(restoreFixed(parsed.data, fixed, { columns: payload.complete.columns, parts: payload.complete.parts })) : null;
    if (restored?.success) return checkParsed(restored.data, payload, opts);
  }
  return first;
}

/** SPEC 9.2 layers 2-4 (references, types, limits): what an answer, or an answer with one alternative swapped in, must pass. */
function staticProblems(rules: LearnResult, payload: LearnPayload, opts: ChecksOptions): RepairProblem[] {
  const problems: RepairProblem[] = [];

  // ----- Layer 2: references -----
  problems.push(...checkRules(rules, { rejectBuiltinFunctionNames: true }).map(ruleProblemToRepairProblem));
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
  return problems;
}

/** SPEC 9.2 layers 2-7 on an answer that passed layers 0-1 (formula text, structure). */
function checkParsed(answer: LearnResult, payload: LearnPayload, opts: ChecksOptions): Checked {
  let rules = answer;
  const problems: RepairProblem[] = staticProblems(rules, payload, opts);

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

  const gatesClean = problems.length === 0;

  // ----- Layer 6a: the overfitting guards (SPEC 9.2 layer 6, engine `learn/overfit.ts`) -----
  // A rule that copies particular rows of the example - a condition on a row's position, a long list of one-row cases, a lookup keyed on an
  // amount - is found whatever the prompt says. A position or a lookup needs no row; a case list is counted on the samples (and a loop round's rows), so only once the rules can run.
  // Completion mode: only the columns the AI step was asked for (the others are the user's own rules). `repair`: one `overfit` problem per
  // column; `fallBack` (the learn's one repair for it was made): the column is reported as unsupported by code and checked no further.
  let overfitFallbacks = 0;
  const asked = payload.complete ? new Set(payload.output.columns.filter((c) => payload.complete!.columns.includes(c.i)).map((c) => c.header)) : null;
  const findings = overfitFindings(rules, { table: gatesClean ? buildSampleInputTable(payload) : null }).filter((f) => asked === null || asked.has(f.outputColumn));
  if (findings.length > 0 && opts.overfit === 'fallBack') {
    rules = withOverfitFallback(rules, findings);
    overfitFallbacks = new Set(findings.map((f) => f.outputColumn)).size;
  } else {
    problems.push(...overfitProblems(findings));
  }

  // ----- Layer 5d: an honest "unsupported" is no mismatch - unless the app's own analysis found how the column is built -----
  // A hint for a column the answer gave up on (copy, template, composition, dependency, bands, window ...) is positive evidence that it can be
  // produced: one repair round to write the rule (SPEC 9.2). A column with no hint stays accepted. Not a gate: the sample run below
  // still runs, so the same repair call also carries any diff on the columns that do have a rule. (A column code reported above is never one.)
  problems.push(...unsupportedDespiteEvidence(rules, payload));

  // ----- Layer 6b: overfitting lint (never a rejection: "Please check" lines) -----
  // (An assumption the answer already carries - a repair copies the previous answer's - is not added twice.)
  const has = new Set(rules.assumptions.map((a) => `${a.reasonCode}\u0000${a.outputColumn ?? ''}`));
  const lintAssumptions = overfitLint(rules, payload).filter((a) => !has.has(`${a.reasonCode}\u0000${a.outputColumn ?? ''}`));
  const rulesWithLint: LearnResult =
    lintAssumptions.length > 0 ? { ...rules, assumptions: [...rules.assumptions, ...lintAssumptions] } : rules;

  // ----- Layer 7: run on the samples (only once every gate above is clean) -----
  // (A column reported as unsupported - `from: null` plus an entry - is left out of the diff: nothing to compare. Whether it should have been
  // given a rule is layer 5d's question, not a comparison.)
  if (gatesClean) {
    problems.push(...runOnSamples(rulesWithLint, payload));
  }

  return { problems, rules: rulesWithLint, overfitFallbacks };
}

// ---------- learn-v8: the answer's alternatives (owner decision 2026-10-04; SPEC 9.2, 21 v12 item 17) ----------

const problemKey = (p: RepairProblem): string => JSON.stringify(p);

/** What a column's rule does, with every computed column it reads written out (and the value map on what it reads): two ways of writing
 * the same rule compare equal. */
function ruleOf(rules: LearnResult, id: string, seen: ReadonlySet<string> = new Set()): unknown {
  const map = rules.transform.valueMaps.find((vm) => vm.column === id)?.map;
  const computed = rules.transform.computed.find((c) => c.id === id);
  if (!computed || seen.has(id)) return { col: id, map };
  const next = new Set(seen).add(id);
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (!isRecord(v)) return v;
    if (typeof v.col === 'string' && Object.keys(v).length === 1) return ruleOf(rules, v.col, next);
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
  };
  return { type: computed.type, expr: walk(computed.expr), map };
}

/**
 * Each alternative passes the same layers as the answer - formula text, structure, references, types, limits - as the answer with only
 * that column's rule swapped in (`from` replaced, its new computed columns run after the answer's own). It is dropped (counted, never
 * repaired, never a reason to repair the answer) when it: adds a problem the answer does not have (a formula that does not parse, an id
 * that clashes with one of the answer's, a type that does not fit the column, a limit), is not of the right shape, names a column the
 * answer does not have or gives no rule for, repeats the answer's own rule, is a second one for its column, is past
 * `limits.learn.maxAlternatives`, is for a column completion mode did not ask for (`complete.columns`), or the prompt offers none (learn-v7).
 */
function checkAlternatives(raw: readonly unknown[], rules: LearnResult, payload: LearnPayload, opts: ChecksOptions): Pick<ChecksResult, 'alternatives' | 'invalidAlternatives'> {
  const alternatives: LearnAlternative[] = [];
  if (opts.alternatives === false) return { alternatives, invalidAlternatives: raw.length };
  let invalid = 0;
  const asked = payload.complete ? new Set(payload.complete.columns.map((i) => payload.output.columns.find((c) => c.i === i)?.header)) : null;
  const known = new Set(staticProblems(rules, payload, opts).map(problemKey));
  for (const candidate of raw) {
    const accepted = alternatives.length < limits.learn.maxAlternatives ? acceptAlternative(candidate, rules, payload, opts, known, asked, alternatives) : null;
    if (accepted) alternatives.push(accepted);
    else invalid++;
  }
  return { alternatives, invalidAlternatives: invalid };
}

function acceptAlternative(
  candidate: unknown,
  rules: LearnResult,
  payload: LearnPayload,
  opts: ChecksOptions,
  known: ReadonlySet<string>,
  asked: ReadonlySet<string | undefined> | null,
  accepted: readonly LearnAlternative[],
): LearnAlternative | null {
  // Layers 0-1: its formula text, then its shape.
  if (!isRecord(candidate)) return null;
  const decoded = formulaRulesFromWire({ transform: { computed: candidate.computed } }, { promptOpsOnly: payload.complete === undefined });
  if (decoded.problems.length > 0) return null;
  const computed = (decoded.rules as { transform: { computed: unknown } }).transform.computed;
  const parsed = LearnAlternativeSchema.safeParse({ ...candidate, computed });
  if (!parsed.success) return null;
  const alternative = parsed.data;

  // Its column: one the answer gives a rule for (one completion mode asked for), and only one alternative per column.
  const at = rules.output.columns.findIndex((c) => c.header === alternative.outputColumn);
  const column = rules.output.columns[at];
  if (!column || column.from === null) return null;
  if (asked && !asked.has(column.header)) return null;
  if (accepted.some((a) => a.outputColumn === alternative.outputColumn)) return null;

  // Layers 2-4 on the answer with only this column's rule swapped in: nothing the answer did not already have.
  const variant: LearnResult = {
    ...rules,
    transform: { ...rules.transform, computed: [...rules.transform.computed, ...alternative.computed] },
    output: { ...rules.output, columns: rules.output.columns.map((c, i) => (i === at ? { ...c, from: alternative.from } : c)) },
  };
  if (!LearnResultSchema.safeParse(variant).success) return null;
  if (staticProblems(variant, payload, opts).some((p) => !known.has(problemKey(p)))) return null;

  // A different rule, not the answer's own written another way.
  if (JSON.stringify(ruleOf(variant, alternative.from)) === JSON.stringify(ruleOf(rules, column.from))) return null;
  return alternative;
}
