#!/usr/bin/env -S pnpm exec tsx
// The model evaluation harness (SPEC 10): runs the full production pipeline
// (pre-flight included) over every case in eval/cases/, for each requested model x
// masking mode x run, and writes a report.
//
//   pnpm eval --models <a>,<b> --masking on,off --runs 3 [--provider anthropic|openai|claude-cli|fake]
//             [--cases <substring>[,<substring>...]] [--out <dir>] [--no-escalation] [--mode full|complete|both]
//             [--prompt learn-v7|learn-v8|learn-v8-noE1|learn-v8.1|learn-v8.1-noE1|learn-v9] [--no-pattern-hints]
//
// Defaults: provider from env (LLM_PROVIDER / .env, see apps/api/src/env.ts), models =
// the provider's configured firstTry model, masking on and off, runs 1, mode full.
// --mode complete runs the local partial result first (no LLM) and then the AI step on what is missing only, the local rules kept as
// a fixed part (LEARN_PROMPT "Completing a partial rules file"); --mode both runs both and the report puts them side by side.
// --prompt sends another prompt version than the current one (with the wire schema it was written for), to compare two on the same code;
// learn-v8-noE1 / learn-v8.1-noE1 are learn-v8 / learn-v8.1 without the E1 line (code completes the data parts from every row), the prompt
// audit's arm B. The default (no --prompt) is `promptVersion`, learn-v7 since 2026-10-05.
// --prompt learn-v9 turns on the AI code checks (docs/proposals/ai-code-checks.md): the AI step may ask code to check ideas on every row
// before it answers; the harness answers them in-process (the same engine code as the browser). --no-pattern-hints leaves the pattern hints
// (bands, dependsOn, contains) out of the payload, to measure the checks against them.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '@formatai/api/env';
import { models as modelConfig, promptVersion } from '@formatai/shared';
import { parseArgs, EvalArgsError } from './lib/args.js';
import { loadCases } from './lib/caseLoader.js';
import { rulesByRecord, runMatrix } from './lib/runner.js';
import { buildCsvReport, buildMarkdownReport, printSummary } from './lib/report.js';

const EVAL_DIR = path.dirname(fileURLToPath(import.meta.url));
const CASES_DIR = path.join(EVAL_DIR, 'cases');

function utcTimestamp(d: Date): string {
  return d.toISOString().replace(/[:.]/g, '-');
}

export async function main(argv: readonly string[]): Promise<void> {
  const args = parseArgs(argv);

  const provider = args.provider ?? loadEnv().LLM_PROVIDER;
  const models = args.models ?? [modelConfig[provider].firstTry];
  const maskingModes = args.masking.map((m) => m === 'on');

  const cases = loadCases(CASES_DIR, args.cases);
  if (cases.length === 0) {
    throw new Error(args.cases ? `no eval cases match "${args.cases}"` : 'no eval cases found under eval/cases/');
  }

  const modeNote = args.modes.length === 1 && args.modes[0] === 'full' ? '' : ` x mode ${args.modes.join('+')}`;
  const hintsNote = args.noPatternHints ? ', pattern hints off' : '';
  console.log(`Running ${cases.length} case(s) x ${models.length} model(s) x ${maskingModes.length} masking mode(s) x ${args.runs} run(s)${modeNote}, provider=${provider}, prompt=${args.prompt ?? promptVersion}${hintsNote}.`);

  const startedAt = new Date();
  const records = await runMatrix({
    cases,
    models,
    maskingModes,
    runs: args.runs,
    provider,
    noEscalation: args.noEscalation,
    modes: args.modes,
    ...(args.prompt ? { prompt: args.prompt } : {}),
    ...(args.noPatternHints ? { patternHints: false } : {}),
    onProgress: (line) => console.log(`  ${line}`),
  });

  const outDir = args.out ?? path.join(EVAL_DIR, 'reports', utcTimestamp(startedAt));
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'report.md'), buildMarkdownReport(records, new Date().toISOString()));
  fs.writeFileSync(path.join(outDir, 'results.csv'), buildCsvReport(records));
  // The rules each AI learn kept (the AI's logic, with what code filled in): `rules/<case>.<mode>.masking-<on|off>.run<n>.json`.
  for (const r of records) {
    const rules = r.path === 'llm' ? rulesByRecord.get(r) : undefined;
    if (!rules) continue;
    fs.mkdirSync(path.join(outDir, 'rules'), { recursive: true });
    fs.writeFileSync(path.join(outDir, 'rules', `${r.case}.${r.mode ?? 'full'}.masking-${r.masking ? 'on' : 'off'}.run${r.run}.json`), `${JSON.stringify(rules, null, 2)}\n`);
  }

  printSummary(records);
  console.log(`\nReport written to ${outDir}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    if (err instanceof EvalArgsError) {
      console.error(`Argument error: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    console.error(err);
    process.exitCode = 1;
  });
}
