// Try flow A on your own files: learn rules from an example input + the output you made by hand.
//   pnpm learn <example-input> <example-output> [--masking on|off] [--provider claude-cli|anthropic|openai]
//              [--model haiku] [--out rules.json]
// Runs everything locally (pair analysis, fast path, masking, verification); only the learn
// payload goes to the LLM, and only when the fast path can't solve it.
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { learnFromExamples, printFormula } from '@formatai/engine';
import { learn, repairFromBrowser, type LlmCallRecord } from '@formatai/api/learn';
import { loadEnv } from '@formatai/api/env';
import {
  assumptionMessages,
  preflightBlockMessages,
  preflightWarnMessages,
  unsupportedMessages,
  type LearnResult,
} from '@formatai/shared';
import { cellText, fail, parseArgs, userPath } from './common';

const { positional, flags } = parseArgs(process.argv.slice(2));
if (positional.length < 2) {
  fail('Usage: pnpm learn <example-input> <example-output> [--masking on|off] [--provider claude-cli] [--model haiku] [--out rules.json]');
}
const inputPath = userPath(positional[0]!);
const outputPath = userPath(positional[1]!);
const masking = (flags.masking ?? 'on') !== 'off';
const rulesPath = flags.out ? userPath(flags.out) : join(dirname(outputPath), `${basename(outputPath, extname(outputPath))}.rules.json`);

const env = { ...loadEnv(), ...(flags.provider ? { LLM_PROVIDER: flags.provider as never } : {}) };
const model = flags.model;

const readBytes = (p: string) => {
  try {
    return new Uint8Array(readFileSync(p));
  } catch {
    return fail(`Can't read ${p}`);
  }
};

console.log(`\nLearning from ${basename(inputPath)} → ${basename(outputPath)}  (masking ${masking ? 'on' : 'off'}, LLM provider ${env.LLM_PROVIDER})`);
const started = Date.now();
const learnOpts = {
  tier: 'paid' as const,
  env,
  ...(model ? { models: { firstTry: model, escalation: model } } : {}),
};
const result = await learnFromExamples<LlmCallRecord>({
  input: { bytes: readBytes(inputPath), name: basename(inputPath) },
  output: { bytes: readBytes(outputPath), name: basename(outputPath) },
  masking,
  // A fresh random key per run, like the browser's per-session key; it never leaves this process.
  ...(masking ? { key: crypto.getRandomValues(new Uint8Array(32)) } : {}),
  tier: 'paid',
  tryAnyway: flags['try-anyway'] === 'true',
  callLearn: (payload) => learn(payload, learnOpts),
  callRepair: (payload, previous, problems) => repairFromBrowser(payload, previous, problems, learnOpts),
});

// ---- Pre-flight ----
const pf = result.preflight;
for (const issue of pf.issues) {
  const msg =
    (preflightBlockMessages as Record<string, { en: string }>)[issue.code]?.en ??
    (preflightWarnMessages as Record<string, { en: string }>)[issue.code]?.en ??
    issue.code;
  console.log(`  ${issue.severity === 'block' ? 'BLOCKED' : 'Note'}: ${msg}`);
}
if (result.path === 'blocked' || !result.rules) {
  console.log(`\nNo rules were produced (${result.path === 'blocked' ? 'blocked before learning' : 'the LLM could not produce valid rules'}).\n`);
  process.exit(2);
}

// ---- What was learned ----
const rules: LearnResult = result.rules;
const computed = new Map(rules.transform.computed.map((c) => [c.id, c] as const));
console.log(`\nPath: ${result.path === 'local' ? 'solved by code (no LLM)' : 'learned by the LLM'}`);
console.log('\nOutput columns:');
for (const col of rules.output.columns) {
  let how = col.from === null ? '(needs your input)' : col.from;
  const c = col.from ? computed.get(col.from) : undefined;
  if (c) how = printFormula(c.expr);
  console.log(`  ${col.header}  ←  ${how}`);
}
if (rules.input.rowFilters?.length) console.log(`\nRow filters: ${JSON.stringify(rules.input.rowFilters)}`);
if (rules.transform.dedupe) console.log(`Duplicates: ${JSON.stringify(rules.transform.dedupe)}`);
if (rules.transform.expand) console.log(`Rows expand: ${rules.transform.expand.mode}`);
for (const u of result.unsupported) console.log(`  Needs your input — ${u.outputColumn}: ${unsupportedMessages[u.reasonCode]?.en ?? u.reasonCode}`);
for (const a of result.assumptions) console.log(`  Please check${a.outputColumn ? ` — ${a.outputColumn}` : ''}: ${assumptionMessages[a.reasonCode]?.en ?? a.reasonCode}`);

// ---- Verification against your whole example ----
const v = result.verification;
if (v) {
  console.log(`\nCheck against your example: ${v.verified ? 'VERIFIED' : 'differences found'} — ${v.matched} of ${v.total} rows match`);
  for (const m of v.mismatches.slice(0, 10)) {
    console.log(`  row ${m.exampleRow}, ${m.column}: your example ${cellText(m.expected)}, rules give ${cellText(m.actual)}`);
  }
  for (const p of v.layoutProblems.slice(0, 5)) console.log(`  layout: ${p}`);
}

// ---- LLM usage ----
if (result.calls.length) {
  const tokIn = result.calls.reduce((s, c) => s + c.tokensIn, 0);
  const tokOut = result.calls.reduce((s, c) => s + c.tokensOut, 0);
  const cached = result.calls.reduce((s, c) => s + c.tokensCached, 0);
  const cost = result.calls.reduce((s, c) => s + c.costUsd, 0);
  console.log(`\nLLM: ${result.calls.length} call(s) [${result.calls.map((c) => `${c.purpose}:${c.model}`).join(', ')}], tokens in ${tokIn} + cached ${cached}, out ${tokOut}, cost $${cost.toFixed(4)}`);
}

writeFileSync(rulesPath, JSON.stringify(rules, null, 2) + '\n', 'utf8');
console.log(`\nRules saved to ${rulesPath}  (${((Date.now() - started) / 1000).toFixed(1)} s)`);
console.log(`Convert a new file with:  pnpm convert "${rulesPath}" <new-file>\n`);
