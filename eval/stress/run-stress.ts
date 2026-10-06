#!/usr/bin/env -S pnpm exec tsx
// The engine stress test (eval/STRESS.md): generates `--n` messy cases from `--seed` on, learns each with the FREE engine (no AI step,
// no network), checks the invariants (`check.ts`), prints a summary and writes every failing seed with a repro to eval/reports/stress/.
//
//   pnpm --filter ./eval stress --n 500 --seed 1            # mixed sizes (1 to 20,000 rows, 2 to 40 columns)
//   pnpm --filter ./eval stress --n 50 --profile small      # small files only (fast)
//   pnpm --filter ./eval stress --only 17,42                # re-run some seeds
//   pnpm --filter ./eval stress --n 3 --profile timing      # 20,000 rows x 20 columns, timed
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWorkbook } from '@formatai/engine';
import { checkCase, type CaseResult } from './check';
import { buildCase, GenError, type SizeProfile, type StressCase } from './gen';
import { delimitedText } from './files';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = path.join(HERE, '..', 'reports', 'stress');

interface Args {
  n: number;
  seed: number;
  profile: SizeProfile;
  only: number[] | null;
  out: string;
  noMask: boolean;
  quiet: boolean;
  /** Also write the repro of a seed with findings only (no failure). */
  dumpFindings: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { n: 100, seed: 1, profile: 'mixed', only: null, out: DEFAULT_OUT, noMask: false, quiet: false, dumpFindings: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === '--n') a.n = Number(v), i++;
    else if (k === '--seed') a.seed = Number(v), i++;
    else if (k === '--profile') a.profile = v as SizeProfile, i++;
    else if (k === '--only') a.only = v!.split(',').map(Number), i++;
    else if (k === '--out') a.out = path.resolve(v!), i++;
    else if (k === '--no-mask') a.noMask = true;
    else if (k === '--quiet') a.quiet = true;
    else if (k === '--dump-findings') a.dumpFindings = true;
    else if (k === '--') continue;
    else throw new Error(`unknown argument ${k}`);
  }
  if (!['small', 'mixed', 'large', 'timing'].includes(a.profile)) throw new Error(`--profile: small | mixed | large | timing`);
  return a;
}

// ---------------------------------------------------------------------------
// Repro files
// ---------------------------------------------------------------------------

async function preview(name: string, bytes: Uint8Array, rows = 12): Promise<string> {
  try {
    const sheet = (await readWorkbook(bytes, name)).sheets[0];
    if (!sheet) return `${name}: no sheet\n`;
    const lines = sheet.rows.slice(0, rows).map((r) => r.map((c) => (c === null || c.v === null ? '' : JSON.stringify(c.v))).join(' | '));
    return `== ${name} (first ${Math.min(rows, sheet.rows.length)} of ${sheet.rows.length} rows)\n${lines.join('\n')}\n`;
  } catch (e) {
    return `== ${name}: unreadable (${(e as Error).message})\n`;
  }
}

async function writeRepro(dir: string, c: StressCase | null, r: CaseResult | { seed: number; error: string; rules?: unknown; files?: { name: string; bytes: Uint8Array }[] }): Promise<void> {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  if (!c) {
    const g = r as { seed: number; error: string; rules?: unknown; files?: { name: string; bytes: Uint8Array }[] };
    fs.writeFileSync(path.join(dir, 'failure.json'), `${JSON.stringify({ seed: g.seed, generator: g.error }, null, 2)}\n`);
    if (g.rules) fs.writeFileSync(path.join(dir, 'reference.rules.json'), `${JSON.stringify(g.rules, null, 2)}\n`);
    for (const f of g.files ?? []) fs.writeFileSync(path.join(dir, f.name), f.bytes);
    return;
  }
  const res = r as CaseResult;
  const { learned, ...summary } = res;
  fs.writeFileSync(path.join(dir, 'failure.json'), `${JSON.stringify({ ...summary, layout: c.layout, columns: c.cols.map((x) => ({ id: x.id, header: x.header, kind: x.kind, emptyRate: x.emptyRate, messRate: x.messRate, injectRate: x.injectRate })) }, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'reference.rules.json'), `${JSON.stringify(c.rules, null, 2)}\n`);
  if (learned) fs.writeFileSync(path.join(dir, 'learned.rules.json'), `${JSON.stringify(learned, null, 2)}\n`);
  for (const f of [c.input, c.output, c.nextInput, c.nextOutput]) fs.writeFileSync(path.join(dir, f.name), f.bytes);
  // The first rows, readable without opening a file.
  const head = c.exampleRows.slice(0, 10).map((row) => row.map((x) => JSON.stringify(delimitedText(x))).join(' | '));
  const text = [
    `seed ${c.seed} (${c.profile}): ${c.exampleRows.length} rows x ${c.cols.length} columns, ${c.layout.fileType} in, ${c.rules.output.file?.type ?? 'xlsx'} out`,
    `columns: ${c.cols.map((x) => `${x.header} [${x.kind}]`).join(', ')}`,
    `== generated example rows (first 10)\n${c.cols.map((x) => x.header).join(' | ')}\n${head.join('\n')}`,
    await preview(c.output.name, c.output.bytes),
    await preview(c.nextInput.name, c.nextInput.bytes),
    await preview(c.nextOutput.name, c.nextOutput.bytes),
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'preview.txt'), `${text}\n`);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function pct(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
}

function countBy<T>(xs: T[], key: (x: T) => string): [string, number][] {
  const m = new Map<string, number>();
  for (const x of xs) m.set(key(x), (m.get(key(x)) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

interface GenFailure {
  seed: number;
  error: string;
}

function summarize(results: CaseResult[], genFailures: GenFailure[], args: Args, elapsedMs: number): { text: string; json: unknown } {
  const failing = results.filter((r) => r.failures.length > 0);
  const failureKinds = countBy(results.flatMap((r) => [...new Set(r.failures.map((f) => `${f.invariant}:${f.kind}`))].map((k) => ({ k }))), (x) => x.k);
  const findingKinds = countBy(results.flatMap((r) => [...new Set(r.findings.map((f) => f.kind))].map((k) => ({ k }))), (x) => x.k);
  const seedsOf = (kind: string): number[] => results.filter((r) => r.failures.some((f) => `${f.invariant}:${f.kind}` === kind)).map((r) => r.seed);
  const findingSeeds = (kind: string): number[] => results.filter((r) => r.findings.some((f) => f.kind === kind)).map((r) => r.seed);
  const paths = countBy(results, (r) => r.path);
  const features = countBy(results.flatMap((r) => r.features.map((f) => ({ f }))), (x) => x.f);
  const learn = results.map((r) => r.ms.learn);
  const convert = results.map((r) => r.ms.convert);
  const big = results.filter((r) => r.rowsIn >= 15000 && r.cols >= 15);
  const sizes = {
    rows: { min: Math.min(...results.map((r) => r.rowsIn)), max: Math.max(...results.map((r) => r.rowsIn)) },
    cols: { min: Math.min(...results.map((r) => r.cols)), max: Math.max(...results.map((r) => r.cols)) },
  };
  const lines: string[] = [];
  lines.push(`# Stress run: ${results.length + genFailures.length} cases (profile ${args.profile}${args.only ? `, seeds ${args.only.join(',')}` : `, seeds ${args.seed}-${args.seed + args.n - 1}`}) in ${(elapsedMs / 1000).toFixed(0)} s`);
  lines.push('');
  lines.push(`Passed: ${results.length - failing.length}; failed: ${failing.length}; generator errors: ${genFailures.length}`);
  lines.push(`Sizes: ${sizes.rows.min}-${sizes.rows.max} rows, ${sizes.cols.min}-${sizes.cols.max} columns`);
  lines.push(`Paths: ${paths.map(([k, n]) => `${k} ${n}`).join(', ')}`);
  lines.push('');
  lines.push('## Failures by kind (invariant:kind - cases - seeds)');
  for (const [k, n] of failureKinds) lines.push(`- ${k}: ${n} - ${seedsOf(k).slice(0, 15).join(', ')}${seedsOf(k).length > 15 ? ' ...' : ''}`);
  if (failureKinds.length === 0) lines.push('- none');
  lines.push('');
  lines.push('## Findings (not failures) by kind - cases - seeds');
  for (const [k, n] of findingKinds) lines.push(`- ${k}: ${n} - ${findingSeeds(k).slice(0, 15).join(', ')}${findingSeeds(k).length > 15 ? ' ...' : ''}`);
  if (findingKinds.length === 0) lines.push('- none');
  if (genFailures.length > 0) {
    lines.push('');
    lines.push('## Generator errors');
    for (const g of genFailures.slice(0, 20)) lines.push(`- seed ${g.seed}: ${g.error.slice(0, 200)}`);
  }
  lines.push('');
  lines.push('## Timing (ms)');
  lines.push(`- learn: p50 ${pct(learn, 50)}, p95 ${pct(learn, 95)}, max ${Math.max(0, ...learn)}`);
  lines.push(`- convert: p50 ${pct(convert, 50)}, p95 ${pct(convert, 95)}, max ${Math.max(0, ...convert)}`);
  for (const r of big) lines.push(`- seed ${r.seed}: ${r.rowsIn} rows x ${r.cols} cols (${r.fileType} -> ${r.outFileType}): learn ${r.ms.learn}, convert ${r.ms.convert}, hold-out convert ${r.ms.holdout}, generate ${r.ms.gen}, mask check ${r.ms.mask}`);
  lines.push('');
  lines.push('## Generator coverage (feature - cases)');
  lines.push(features.map(([k, n]) => `${k} ${n}`).join(', '));
  const json = { args, elapsedMs, cases: results.length, failing: failing.length, genFailures, paths, failureKinds, findingKinds, features, results: results.map(({ learned: _l, ...r }) => r) };
  return { text: lines.join('\n'), json };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const seeds = args.only ?? Array.from({ length: args.n }, (_, i) => args.seed + i);
  fs.mkdirSync(args.out, { recursive: true });
  const results: CaseResult[] = [];
  const genFailures: GenFailure[] = [];
  const t0 = Date.now();
  for (const seed of seeds) {
    let c: StressCase;
    try {
      c = await buildCase(seed, { profile: args.profile });
    } catch (e) {
      const message = e instanceof GenError ? e.message : `${(e as Error).stack ?? e}`;
      genFailures.push({ seed, error: message });
      console.log(`seed ${seed}: GENERATOR ${message.slice(0, 200)}`);
      await writeRepro(path.join(args.out, `seed-${seed}`), null, { seed, error: message, ...(e instanceof GenError ? { rules: e.rules, files: e.files } : {}) });
      continue;
    }
    let r: CaseResult;
    try {
      r = await checkCase(c, { noMask: args.noMask });
    } catch (e) {
      r = {
        seed,
        profile: c.profile,
        features: c.features,
        rowsIn: c.exampleRows.length,
        cols: c.cols.length,
        outCols: c.rules.output.columns.length,
        fileType: c.layout.fileType,
        outFileType: c.rules.output.file?.type ?? 'xlsx',
        path: 'error',
        solved: 0,
        needsAiParts: [],
        failures: [{ kind: 'checkCrashed', invariant: 1, detail: `${(e as Error).stack ?? e}`.slice(0, 500) }],
        findings: [],
        ms: { gen: c.genMs, learn: 0, convert: 0, holdout: 0, mask: 0 },
        learned: null,
      };
    }
    results.push(r);
    const status = r.failures.length === 0 ? 'ok' : `FAIL ${[...new Set(r.failures.map((f) => f.kind))].join(',')}`;
    if (!args.quiet || r.failures.length > 0) {
      console.log(`seed ${seed}: ${r.rowsIn}x${r.cols} ${r.fileType}->${r.outFileType} ${r.path} ${r.solved}/${r.outCols} learn ${r.ms.learn}ms convert ${r.ms.convert}ms ${status}${r.findings.length > 0 ? ` (${[...new Set(r.findings.map((f) => f.kind))].join(',')})` : ''}`);
    }
    if (r.failures.length > 0 || (args.dumpFindings && r.findings.length > 0)) {
      for (const f of r.failures.slice(0, 3)) console.log(`    [${f.invariant}:${f.kind}] ${f.detail.slice(0, 300)}`);
      await writeRepro(path.join(args.out, `seed-${seed}`), c, r);
    }
  }
  const { text, json } = summarize(results, genFailures, args, Date.now() - t0);
  fs.writeFileSync(path.join(args.out, 'summary.md'), `${text}\n`);
  fs.writeFileSync(path.join(args.out, 'summary.json'), `${JSON.stringify(json, null, 2)}\n`);
  console.log(`\n${text}\n\nWritten to ${args.out}`);
}

await main();
