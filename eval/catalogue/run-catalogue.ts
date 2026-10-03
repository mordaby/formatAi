#!/usr/bin/env -S pnpm exec tsx
// Runs the rule catalogue: for every selected type and seed, builds the input and the expected output, then measures
//   (a) the LANGUAGE layer - the reference rule parses, type-checks and reproduces the expected output,
//   (b) the FAST layer     - the free code engine (pair analysis + strict fast path, AI not allowed) detects it, and
//   (c) the HOLD-OUT       - what it learned converts a "next month" file exactly.
// Without --ai there is no AI/LLM call at all. Writes report.md, report.csv and results.json next to this file (generated, git-ignored).
//
//   pnpm --filter @formatai/eval exec tsx catalogue/run-catalogue.ts [options]
//
//   --types <list>     comma-separated: full ids, a topic ("extraction") or a prefix ("dates.add-*"). Default: all.
//   --seeds <list>     comma-separated seeds (default 1,2).
//   --list             print the catalogue (id, topic, language, expressible) and exit.
//   --dump [dir]       also write every generated file and the rules (reference and learned) under dir (default catalogue/.cache).
//   --out <dir>        where report.md / report.csv / results.json go (default: this directory).
//   --report-only      do not measure: re-render the report from the existing results.json (it shows AI results when the file has them).
//
//   --ai <model>       THE AI MEASUREMENT (spends tokens): on every type the language can express and the free engine does not solve
//                      (the "needs-AI set"), runs the real learn flow with the AI step allowed and records the outcome in results.json.
//     --provider <p>     anthropic | openai | claude-cli | fake. Default: LLM_PROVIDER from the environment / .env. `--ai fake` is always the fake provider.
//     --masking on|off   default on
//     --mode full|complete   default complete: the free engine first, then the AI step on what it left (the app's default path)
//     --no-escalation    skip the escalation model
//     --chunk N/M        only the N-th of M deterministic parts of the needs-AI set, so a long run can be spread over several sessions
//     --resume           skip (type, seed) pairs results.json already holds for the same model/mode/masking/escalation
//     --plan             print the needs-AI set, the chunk and what would run (or be skipped), then stop: no LLM call
//     --replace          overwrite AI results recorded under another model/mode/masking (otherwise such a run refuses to start)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '@formatai/api/env';
import type { LlmProviderName } from '@formatai/shared';
import { AiConflictError, referenceAnswerFake, runAiMeasurement } from './ai';
import { mergeRecords } from './aiRecords';
import { CatalogueArgsError, parseArgs, type AiArgs, type CatalogueArgs } from './args';
import { measure } from './measure';
import { renderCsv, renderMarkdown, summarize } from './report';
import { CATALOGUE, selectTypes } from './topics';
import type { AiConfigRecord, CatalogueRecord } from './types';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ORDER = CATALOGUE.map((t) => t.id);

function readResults(resultsPath: string): CatalogueRecord[] {
  return fs.existsSync(resultsPath) ? (JSON.parse(fs.readFileSync(resultsPath, 'utf-8')) as CatalogueRecord[]) : [];
}

/** Written whole to a temp file and renamed: a crash or Ctrl-C in the middle of a long AI run never leaves a half-written results.json. */
function writeResults(resultsPath: string, records: readonly CatalogueRecord[]): void {
  fs.mkdirSync(path.dirname(resultsPath), { recursive: true });
  const tmp = `${resultsPath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(records, null, 1)}\n`);
  fs.renameSync(tmp, resultsPath);
}

function writeReport(out: string, records: CatalogueRecord[]): void {
  const summary = summarize(records);
  fs.writeFileSync(path.join(out, 'report.md'), renderMarkdown(summary));
  fs.writeFileSync(path.join(out, 'report.csv'), renderCsv(records));
  console.log(`wrote ${path.join(out, 'report.md')}, report.csv, results.json`);
  const t = summary.totals;
  console.log(`types ${t.types}: language OK ${t.languageOk} (gaps ${t.languageGap}, broken ${t.languageBroken}); fast solved ${t.fastSolved}, partial ${t.fastPartial}, nothing ${t.fastNone}, wrong ${t.fastOverfit + t.fastUnverified} (${t.fastOverfit} overfit, ${t.fastUnverified} unverified)`);
  const ai = summary.ai?.total;
  if (ai) console.log(`AI: ${ai.needsAi} types need it; learned ${ai.learned}, verified only ${ai.verifiedOnly}, not learned ${ai.failed}${ai.errors > 0 ? `, errors ${ai.errors}` : ''}, not run ${ai.notRun}`);
}

async function runAi(args: CatalogueArgs, ai: AiArgs): Promise<void> {
  const provider: LlmProviderName = ai.provider ?? loadEnv().LLM_PROVIDER;
  // The provider the run says is THE provider: learn() reaches the LLM through env.LLM_PROVIDER, so it is set here (as the eval runner does).
  const env = { ...loadEnv(), LLM_PROVIDER: provider };
  const config: AiConfigRecord = { model: ai.model, provider, mode: ai.mode, masking: ai.masking, noEscalation: ai.noEscalation };
  const types = selectTypes(args.types);
  const resultsPath = path.join(args.out, 'results.json');
  const fake = provider === 'fake';

  if (!ai.plan) {
    console.log(
      fake
        ? `AI measurement with the FAKE provider (canned reference answers, no LLM call): model ${ai.model}, mode ${ai.mode}, masking ${ai.masking ? 'on' : 'off'}.${ai.masking ? ' (The fake answers in real words: use --masking off to see verified results.)' : ''}`
        : `AI measurement: REAL LLM CALLS via provider ${provider}, model ${ai.model}, mode ${ai.mode}, masking ${ai.masking ? 'on' : 'off'}, escalation ${ai.noEscalation ? 'off' : 'on'}${ai.chunk ? `, chunk ${ai.chunk.index}/${ai.chunk.total}` : ''}${ai.resume ? ', resuming' : ''}.`,
    );
  }

  let stop = false;
  const onSigint = (): void => {
    if (stop) process.exit(130);
    stop = true;
    console.log('\nstopping after the current measurement (Ctrl-C again to quit now) ...');
  };
  process.on('SIGINT', onSigint);

  const started = Date.now();
  let result;
  try {
    result = await runAiMeasurement({
      config,
      env,
      types,
      seeds: args.seeds,
      records: readResults(resultsPath),
      chunk: ai.chunk,
      resume: ai.resume,
      replace: ai.replace,
      planOnly: ai.plan,
      ...(args.dump !== undefined ? { dumpDir: args.dump } : {}),
      ...(fake ? { completeFor: (type) => referenceAnswerFake(type) } : {}),
      onRecords: (records) => writeResults(resultsPath, records),
      log: (line) => console.log(line),
      shouldStop: () => stop,
      order: ORDER,
    });
  } catch (e) {
    if (e instanceof AiConflictError) {
      console.error(e.message);
      process.exitCode = 2;
      return;
    }
    throw e;
  } finally {
    process.off('SIGINT', onSigint);
  }

  const { plan } = result;
  const part = ai.chunk ? ` (chunk ${ai.chunk.index}/${ai.chunk.total}: ${plan.chunk.length} types)` : '';
  console.log(`needs the AI step: ${plan.needs.length} of ${types.length} selected types${part}; ${plan.todo.length} (type, seed) pair(s) to measure, ${plan.done.length} already done (--resume)`);
  if (ai.plan) {
    for (const item of plan.todo) console.log(`  would run   ${item.type.id.padEnd(40)} seed ${item.seed}`);
    for (const item of plan.done) console.log(`  would skip  ${item.type.id.padEnd(40)} seed ${item.seed}`);
    if (plan.conflicts.length > 0) console.log(`  ${plan.conflicts.length} pair(s) hold AI results of another configuration (a real run needs --replace or another --out)`);
    return;
  }
  console.log(`\n${result.measured} measurement(s) in ${((Date.now() - started) / 1000).toFixed(1)} s${result.stopped ? ' (stopped early: run again with --resume to continue)' : ''}`);
  writeResults(resultsPath, result.records);
  writeReport(args.out, result.records);
}

async function main(): Promise<void> {
  let args: CatalogueArgs;
  try {
    args = parseArgs(process.argv.slice(2), { out: HERE, dumpDir: path.join(HERE, '.cache') });
  } catch (e) {
    if (!(e instanceof CatalogueArgsError)) throw e;
    console.error(e.message);
    process.exitCode = 2;
    return;
  }

  if (args.list) {
    for (const t of CATALOGUE) console.log(`${t.id.padEnd(40)} ${t.topic.padEnd(11)} ${t.lang}  ${t.rule === null ? `NOT EXPRESSIBLE (${t.missing?.capability})` : 'expressible'}`);
    console.log(`\n${CATALOGUE.length} types`);
    return;
  }

  if (args.ai) {
    try {
      await runAi(args, args.ai);
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('--types:')) {
        console.error(e.message);
        process.exitCode = 2;
        return;
      }
      throw e;
    }
    return;
  }

  const resultsPath = path.join(args.out, 'results.json');
  let records: CatalogueRecord[];
  if (args.reportOnly) {
    records = readResults(resultsPath);
    console.log(`re-rendering ${records.length} records from ${resultsPath}`);
  } else {
    let types;
    try {
      types = selectTypes(args.types);
    } catch (e) {
      console.error((e as Error).message);
      process.exitCode = 2;
      return;
    }
    const fresh: CatalogueRecord[] = [];
    const started = Date.now();
    for (const type of types) {
      for (const seed of args.seeds) {
        const rec = await measure(type, seed, args.dump !== undefined ? { dumpDir: args.dump } : {});
        fresh.push(rec);
        const lang = rec.language.expressible ? (rec.language.valid && rec.language.reproduces ? 'language OK' : 'LANGUAGE BROKEN') : `language gap (${rec.language.capability})`;
        console.log(`${type.id.padEnd(40)} seed ${seed}  ${lang.padEnd(34)} fast: ${rec.fast.path}/${rec.fast.status}${rec.fast.holdOut !== 'n/a' ? ` holdout ${rec.fast.holdOut}` : ''}`);
      }
    }
    console.log(`\n${fresh.length} records in ${((Date.now() - started) / 1000).toFixed(1)} s`);
    // A partial run (--types) must not overwrite a full results file with a subset: merge by (type, seed). Either way a re-measured record keeps the
    // AI result it had: the free layers cost nothing to redo, the AI measurements cost tokens.
    records = mergeRecords(readResults(resultsPath), fresh, { order: ORDER, replaceAll: args.types.length === 0 });
    writeResults(resultsPath, records);
  }

  writeReport(args.out, records);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
