#!/usr/bin/env -S pnpm exec tsx
// Runs the rule catalogue: for every selected type and seed, builds the input and the expected output, then measures
//   (a) the LANGUAGE layer - the reference rule parses, type-checks and reproduces the expected output,
//   (b) the FAST layer     - the free code engine (pair analysis + strict fast path, AI not allowed) detects it, and
//   (c) the HOLD-OUT       - what it learned converts a "next month" file exactly.
// No AI/LLM calls. Writes report.md, report.csv and results.json next to this file (generated, git-ignored).
//
//   pnpm --filter @formatai/eval exec tsx catalogue/run-catalogue.ts [options]
//
//   --types <list>     comma-separated: full ids, a topic ("extraction") or a prefix ("dates.add-*"). Default: all.
//   --seeds <list>     comma-separated seeds (default 1,2).
//   --list             print the catalogue (id, topic, language, expressible) and exit.
//   --dump [dir]       also write every generated file and the rules (reference and learned) under dir (default catalogue/.cache).
//   --out <dir>        where report.md / report.csv / results.json go (default: this directory).
//   --report-only      do not measure: re-render the report from the existing results.json (e.g. after the AI phase added `ai`).
//   --ai <model>       reserved for the AI phase (not implemented here: this run never calls an LLM).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { measure } from './measure';
import { renderCsv, renderMarkdown, summarize } from './report';
import { CATALOGUE, selectTypes } from './topics';
import type { CatalogueRecord } from './types';

const HERE = path.dirname(fileURLToPath(import.meta.url));

interface Args {
  types: string[];
  seeds: number[];
  list: boolean;
  dump?: string;
  out: string;
  reportOnly: boolean;
  ai?: string;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { types: [], seeds: [1, 2], list: false, out: HERE, reportOnly: false };
  const split = (v: string): string[] => v.split(',').map((s) => s.trim()).filter((s) => s !== '');
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!;
    const eq = raw.indexOf('=');
    const flag = eq >= 0 ? raw.slice(0, eq) : raw;
    const inline = eq >= 0 ? raw.slice(eq + 1) : undefined;
    const value = (): string => {
      if (inline !== undefined) return inline;
      const v = argv[++i];
      if (v === undefined) throw new Error(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case '--types':
        args.types = split(value());
        break;
      case '--seeds':
        args.seeds = split(value()).map((s) => {
          const n = Number(s);
          if (!Number.isInteger(n)) throw new Error(`--seeds: "${s}" is not an integer`);
          return n;
        });
        break;
      case '--list':
        args.list = true;
        break;
      case '--dump': {
        const next = argv[i + 1];
        args.dump = inline ?? (next !== undefined && !next.startsWith('--') ? (i++, next) : path.join(HERE, '.cache'));
        break;
      }
      case '--out':
        args.out = path.resolve(value());
        break;
      case '--report-only':
        args.reportOnly = true;
        break;
      case '--ai':
        args.ai = value();
        break;
      default:
        throw new Error(`unknown option ${raw}`);
    }
  }
  return args;
}

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 2;
    return;
  }

  if (args.list) {
    for (const t of CATALOGUE) console.log(`${t.id.padEnd(40)} ${t.topic.padEnd(11)} ${t.lang}  ${t.rule === null ? `NOT EXPRESSIBLE (${t.missing?.capability})` : 'expressible'}`);
    console.log(`\n${CATALOGUE.length} types`);
    return;
  }
  if (args.ai !== undefined) {
    console.error('--ai is reserved for the AI measurement phase; this catalogue run never calls an LLM. Re-run without --ai.');
    process.exitCode = 2;
    return;
  }

  const resultsPath = path.join(args.out, 'results.json');
  let records: CatalogueRecord[];
  if (args.reportOnly) {
    records = JSON.parse(fs.readFileSync(resultsPath, 'utf-8')) as CatalogueRecord[];
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
    records = [];
    const started = Date.now();
    for (const type of types) {
      for (const seed of args.seeds) {
        const rec = await measure(type, seed, args.dump !== undefined ? { dumpDir: args.dump } : {});
        records.push(rec);
        const lang = rec.language.expressible ? (rec.language.valid && rec.language.reproduces ? 'language OK' : 'LANGUAGE BROKEN') : `language gap (${rec.language.capability})`;
        console.log(`${type.id.padEnd(40)} seed ${seed}  ${lang.padEnd(34)} fast: ${rec.fast.path}/${rec.fast.status}${rec.fast.holdOut !== 'n/a' ? ` holdout ${rec.fast.holdOut}` : ''}`);
      }
    }
    console.log(`\n${records.length} records in ${((Date.now() - started) / 1000).toFixed(1)} s`);
    // A partial run (--types) must not overwrite a full results file with a subset: merge by (type, seed).
    if (fs.existsSync(resultsPath) && args.types.length > 0) {
      const old = JSON.parse(fs.readFileSync(resultsPath, 'utf-8')) as CatalogueRecord[];
      const key = (r: CatalogueRecord): string => `${r.type}#${r.seed}`;
      const fresh = new Set(records.map(key));
      records = [...old.filter((r) => !fresh.has(key(r))), ...records];
    }
    fs.mkdirSync(args.out, { recursive: true });
    fs.writeFileSync(resultsPath, `${JSON.stringify(records, null, 1)}\n`);
  }

  const summary = summarize(records);
  fs.writeFileSync(path.join(args.out, 'report.md'), renderMarkdown(summary));
  fs.writeFileSync(path.join(args.out, 'report.csv'), renderCsv(records));
  console.log(`wrote ${path.join(args.out, 'report.md')}, report.csv, results.json`);
  const t = summary.totals;
  console.log(`types ${t.types}: language OK ${t.languageOk} (gaps ${t.languageGap}, broken ${t.languageBroken}); fast solved ${t.fastSolved}, partial ${t.fastPartial}, nothing ${t.fastNone}, wrong ${t.fastOverfit + t.fastUnverified} (${t.fastOverfit} overfit, ${t.fastUnverified} unverified)`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
