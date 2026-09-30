#!/usr/bin/env -S pnpm exec tsx
// The model evaluation harness (SPEC 10): runs the full production pipeline
// (pre-flight included) over every case in eval/cases/, for each requested model x
// masking mode x run, and writes a report.
//
//   pnpm eval --models <a>,<b> --masking on,off --runs 3 [--provider anthropic|openai|claude-cli|fake]
//             [--cases <substring>] [--out <dir>] [--no-escalation]
//
// Defaults: provider from env (LLM_PROVIDER / .env, see apps/api/src/env.ts), models =
// the provider's configured firstTry model, masking on and off, runs 1.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '@formatai/api/env';
import { models as modelConfig } from '@formatai/shared';
import { parseArgs, EvalArgsError } from './lib/args.js';
import { loadCases } from './lib/caseLoader.js';
import { runMatrix } from './lib/runner.js';
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

  console.log(`Running ${cases.length} case(s) x ${models.length} model(s) x ${maskingModes.length} masking mode(s) x ${args.runs} run(s), provider=${provider}.`);

  const startedAt = new Date();
  const records = await runMatrix({
    cases,
    models,
    maskingModes,
    runs: args.runs,
    provider,
    noEscalation: args.noEscalation,
    onProgress: (line) => console.log(`  ${line}`),
  });

  const outDir = args.out ?? path.join(EVAL_DIR, 'reports', utcTimestamp(startedAt));
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'report.md'), buildMarkdownReport(records, new Date().toISOString()));
  fs.writeFileSync(path.join(outDir, 'results.csv'), buildCsvReport(records));

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
