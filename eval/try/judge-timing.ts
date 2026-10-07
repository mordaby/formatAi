// How long the browser's own work on ONE AI answer takes on a big example (engine audit, 2026-10-07, fix 12): code's fill from every row,
// the overfitting guards, the one-time and list questions, the full verification - each runs the rules on every row of the example. No LLM:
// a fixed answer plays the AI step. Generates a csv pair of N rows (a branch lookup, a value map, two cut-offs, a hand-edited first row).
//   pnpm --filter ./eval exec tsx try/judge-timing.ts --rows 20000,100000 [--budget <ms>]
import { analyzePair, copiedLists, exampleTable, fillParams, learnFromExamples, oneTimeQuestions, overfitFindings, parseFormula, readWorkbook, sniffDelimitedText, verifyAgainstExample, type PairAnalysis } from '@formatai/engine';
import { limits, type Expr, type LearnResult } from '@formatai/shared';
import { parseArgs } from './common';

const { flags } = parseArgs(process.argv.slice(2));
const sizes = (flags.rows ?? '20000,100000').split(',').map(Number);
const budgetMs = flags.budget !== undefined ? Number(flags.budget) : limits.learn.judge.timeBudgetMs;

const BRANCHES = Array.from({ length: 50 }, (_, i) => ({ code: 100 + i, name: `Branch ${String.fromCharCode(65 + (i % 26))}${Math.floor(i / 26) + 1}` }));
const REGIONS = ['N', 'S', 'E', 'W', 'C'];
const REGION_NAME: Record<string, string> = { N: 'North', S: 'South', E: 'East', W: 'West', C: 'Center' };
const sizeOf = (t: number): string => (t < 900 ? 'Small' : t < 4800 ? 'Medium' : 'Big');

function pair(n: number): { input: Uint8Array; output: Uint8Array } {
  const inLines = ['Ref,Branch,Region,Qty,Price'];
  const outLines = ['Ref,Branch Name,Total,Size,Region Name,Note'];
  for (let i = 0; i < n; i++) {
    const b = BRANCHES[(i * 7) % 50]!;
    const region = REGIONS[(i * 3) % 5]!;
    const qty = 1 + ((i * 13) % 40);
    const price = 5 + ((i * 29) % 200);
    const total = qty * price;
    inLines.push(`R${100000 + i},${b.code},${region},${qty},${price}`);
    outLines.push(`R${100000 + i},${b.name},${total},${sizeOf(total)},${REGION_NAME[region]},${i === 0 ? 'first' : ''}`);
  }
  const enc = new TextEncoder();
  return { input: enc.encode(`${inLines.join('\r\n')}\r\n`), output: enc.encode(`${outLines.join('\r\n')}\r\n`) };
}

const f = (text: string): Expr => {
  const p = parseFormula(text, { allowWindows: true });
  if (!p.ok) throw new Error(`${text}: ${p.error.message}`);
  return p.expr;
};

/** The AI's answer as it would write it from a dozen rows: two branch rows, two region entries, rough cut-offs, the hand-edited first row. */
const ANSWER: LearnResult = {
  schemaVersion: 1,
  input: {
    sheet: { pick: 'first' },
    headerRow: 'auto',
    columns: [
      { id: 'ref', header: 'Ref', type: 'text' },
      { id: 'branch', header: 'Branch', type: 'integer' },
      { id: 'region', header: 'Region', type: 'text' },
      { id: 'qty', header: 'Qty', type: 'integer' },
      { id: 'price', header: 'Price', type: 'integer' },
    ],
  },
  transform: {
    computed: [
      { id: 'branchName', type: 'text', expr: f('lookup("branches", branch, "name")') },
      { id: 'total', type: 'integer', expr: f('qty * price') },
      { id: 'size', type: 'text', expr: f('if(total < 1000, "Small", if(total < 5000, "Medium", "Big"))') },
      { id: 'regionName', type: 'text', expr: f('region') },
      { id: 'note', type: 'text', expr: f('if(ref = "R100000", "first", "")') },
    ],
    valueMaps: [{ column: 'regionName', map: { N: 'North', S: 'South' }, onMissing: 'flag' }],
    sort: [],
    tables: [{ name: 'branches', columns: ['code', 'name'], rows: [[BRANCHES[0]!.code, BRANCHES[0]!.name], [BRANCHES[7]!.code, BRANCHES[7]!.name]] }],
  },
  output: {
    sheetName: 'Sheet1',
    direction: 'ltr',
    language: 'en',
    file: { type: 'csv', delimiter: ',', header: true, encoding: 'utf8', quote: 'minimal' },
    titleRows: [],
    columns: [
      { header: 'Ref', from: 'ref' },
      { header: 'Branch Name', from: 'branchName' },
      { header: 'Total', from: 'total' },
      { header: 'Size', from: 'size' },
      { header: 'Region Name', from: 'regionName' },
      { header: 'Note', from: 'note' },
    ],
  },
  validations: [],
  unsupported: [],
  assumptions: [],
};

async function timed<T>(label: string, fn: () => T | Promise<T>, out: Record<string, number>): Promise<T> {
  const t = performance.now();
  const r = await fn();
  out[label] = Math.round(performance.now() - t);
  return r;
}

for (const n of sizes) {
  const { input, output } = pair(n);
  const ms: Record<string, number> = {};
  const analysis = await timed('read + analyze', async () => {
    const a = analyzePair(await readWorkbook(input, 'in.csv'), await readWorkbook(output, 'out.csv'), { outputSniff: sniffDelimitedText(output) });
    if (!a.ok) throw new Error('analysis failed');
    return a as PairAnalysis;
  }, ms);
  const filled = await timed('fillParams', () => fillParams(ANSWER, analysis), ms);
  await timed('overfit guards', () => overfitFindings(filled.rules, { table: exampleTable(analysis) }), ms);
  const v = await timed('verify (full, wrong rows)', () => verifyAgainstExample(filled.rules, analysis, { wrongRows: true }), ms);
  await timed('one-time + list questions', () => oneTimeQuestions(filled.rules, analysis), ms);
  await timed('copiedLists (list round trigger)', () => copiedLists(filled.rules, analysis), ms);
  // The whole learn with the fixed answer: its first judgement, the list round (answered the same) and the questions at the end.
  let calls = 0;
  const flow = await timed('learnFromExamples (whole learn, fake AI)', () =>
    learnFromExamples({
      input: { bytes: input, name: 'in.csv' },
      output: { bytes: output, name: 'out.csv' },
      masking: false,
      judgeBudgetMs: budgetMs,
      tier: 'paid',
      callLearn: async () => ({ rules: ANSWER, problems: [], calls: [++calls] }),
      callRepair: async () => ({ rules: ANSWER, problems: [], calls: [++calls] }),
    }), ms);
  console.log(`\n${n} rows: verified ${v.verified} (${v.matched}/${v.total}); filled ${filled.filled.map((x) => `${x.kind} ${x.count}`).join(', ')}; learn path ${flow.path}, verified ${flow.stages.verifiedAfterRepair}, calls ${calls}${flow.timeBudget ? `, time budget hit: ${JSON.stringify(flow.timeBudget)}` : ''}; loop ${flow.loop?.rounds} round(s), end ${flow.loop?.end}`);
  for (const [k, t] of Object.entries(ms)) console.log(`  ${k.padEnd(42)} ${String(t).padStart(7)} ms`);
}
console.log(`\n(judge budget: ${budgetMs} ms per judged answer)`);
