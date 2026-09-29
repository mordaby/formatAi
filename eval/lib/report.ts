// SPEC 10 report: markdown + CSV, per model x masking mode, plus failures grouped by
// feature/reason code/domain and a per-case table. `results.csv` carries one row per
// individual run (case x model x masking x run) for anyone who wants to slice the raw
// data themselves; the markdown carries the aggregates a human actually reads.
import type { RunRecord } from './runner.js';

function pct(n: number, d: number): string {
  return d === 0 ? 'n/a' : `${((100 * n) / d).toFixed(0)}%`;
}

function avg(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

function csvCell(v: unknown): string {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// ---------------------------------------------------------------------------
// Per model x masking summary
// ---------------------------------------------------------------------------

interface GroupSummary {
  model: string;
  masking: boolean;
  n: number;
  shareBlocked: string;
  shareFastPath: string;
  shareSchemaValid: string;
  verifiedFirstCall: string;
  verifiedAfterRepair: string;
  expectationMet: string;
  holdOutPassRate: string;
  avgTokensIn: number;
  avgTokensOut: number;
  avgTokensCached: number;
  costPerLearnUsd: number;
  avgLatencyMs: number;
}

function groupKey(model: string, masking: boolean): string {
  return `${model}\u0000${masking ? 'on' : 'off'}`;
}

function summarizeGroup(model: string, masking: boolean, records: readonly RunRecord[]): GroupSummary {
  const n = records.length;
  const blocked = records.filter((r) => r.path === 'blocked').length;
  const fastPath = records.filter((r) => r.fastPath).length;
  const llmRuns = records.filter((r) => r.path === 'llm');
  const schemaValid = llmRuns.filter((r) => r.schemaValid).length;
  const verifiedFirst = llmRuns.filter((r) => r.verifiedFirstCall).length;
  const verifiedAfter = llmRuns.filter((r) => r.verifiedAfterRepair).length;
  const metExpectation = records.filter((r) => r.expectationMet).length;
  const holdOutEligible = records.filter((r) => r.holdOut !== 'n/a');
  const holdOutPass = holdOutEligible.filter((r) => r.holdOut === 'pass').length;

  return {
    model,
    masking,
    n,
    shareBlocked: pct(blocked, n),
    shareFastPath: pct(fastPath, n),
    shareSchemaValid: pct(schemaValid, llmRuns.length),
    verifiedFirstCall: pct(verifiedFirst, llmRuns.length),
    verifiedAfterRepair: pct(verifiedAfter, llmRuns.length),
    expectationMet: pct(metExpectation, n),
    holdOutPassRate: pct(holdOutPass, holdOutEligible.length),
    avgTokensIn: avg(llmRuns.map((r) => r.tokensIn)),
    avgTokensOut: avg(llmRuns.map((r) => r.tokensOut)),
    avgTokensCached: avg(llmRuns.map((r) => r.tokensCached)),
    costPerLearnUsd: avg(llmRuns.map((r) => r.costUsd)),
    avgLatencyMs: avg(llmRuns.map((r) => r.latencyMs)),
  };
}

function groupSummaries(records: readonly RunRecord[]): GroupSummary[] {
  const groups = new Map<string, RunRecord[]>();
  for (const r of records) {
    const key = groupKey(r.model, r.masking);
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }
  const out: GroupSummary[] = [];
  for (const [key, list] of groups) {
    const [model, maskingLabel] = key.split('\u0000') as [string, string];
    out.push(summarizeGroup(model, maskingLabel === 'on', list));
  }
  out.sort((a, b) => a.model.localeCompare(b.model) || Number(a.masking) - Number(b.masking));
  return out;
}

// ---------------------------------------------------------------------------
// Failures grouped by feature / reason code / domain
// ---------------------------------------------------------------------------

function tally(records: readonly RunRecord[], keyOf: (r: RunRecord) => readonly string[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const r of records) {
    for (const k of keyOf(r)) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** The reason code embedded in a classification label ("blocked:x" -> "x",
 * "unsupported:a+b" -> ["a","b"]), or the label itself for "failed"/"notVerified". */
function reasonCodesOf(r: RunRecord): string[] {
  const c = r.classification;
  if (c.startsWith('blocked:')) return [c.slice('blocked:'.length)];
  if (c.startsWith('unsupported:')) return c.slice('unsupported:'.length).split('+');
  return [c];
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

function markdownTable(headers: string[], rows: (string | number)[][]): string {
  const head = `| ${headers.join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((r) => `| ${r.map(String).join(' | ')} |`).join('\n');
  return [head, sep, body].filter(Boolean).join('\n');
}

export function buildMarkdownReport(records: RunRecord[], generatedAt: string): string {
  const lines: string[] = [];
  lines.push('# Model evaluation report (SPEC 10)', '', `Generated: ${generatedAt}`, `Total runs: ${records.length}`, '');

  lines.push('## Per model x masking', '');
  const groups = groupSummaries(records);
  lines.push(
    markdownTable(
      ['Model', 'Masking', 'n', 'Blocked', 'Fast path', 'Schema-valid', 'Verified (1st call)', 'Verified (after repair)', 'Expectation met', 'Hold-out pass', 'Avg tok in', 'Avg tok out', 'Avg tok cached', 'Cost/learn (USD)', 'Avg latency (ms)'],
      groups.map((g) => [
        g.model,
        g.masking ? 'on' : 'off',
        g.n,
        g.shareBlocked,
        g.shareFastPath,
        g.shareSchemaValid,
        g.verifiedFirstCall,
        g.verifiedAfterRepair,
        g.expectationMet,
        g.holdOutPassRate,
        g.avgTokensIn.toFixed(0),
        g.avgTokensOut.toFixed(0),
        g.avgTokensCached.toFixed(0),
        g.costPerLearnUsd.toFixed(4),
        g.avgLatencyMs.toFixed(0),
      ]),
    ),
  );
  lines.push('');

  const failures = records.filter((r) => !r.expectationMet);
  lines.push('## Failures', '', `${failures.length} of ${records.length} runs did not meet their case's expectation.`, '');

  lines.push('### By feature', '', markdownTable(['Feature', 'Failures'], tally(failures, (r) => r.features).map(([k, n]) => [k, n])) || '(none)', '');
  lines.push('### By reason code', '', markdownTable(['Reason', 'Failures'], tally(failures, reasonCodesOf).map(([k, n]) => [k, n])) || '(none)', '');
  lines.push('### By domain', '', markdownTable(['Domain', 'Failures'], tally(failures, (r) => [r.domain]).map(([k, n]) => [k, n])) || '(none)', '');
  lines.push('');

  lines.push('## Per case', '');
  const byCase = new Map<string, RunRecord[]>();
  for (const r of records) {
    const list = byCase.get(r.case);
    if (list) list.push(r);
    else byCase.set(r.case, [r]);
  }
  const caseRows: (string | number)[][] = [...byCase.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, rs]) => {
      const n = rs.length;
      const met = rs.filter((r) => r.expectationMet).length;
      const holdOutEligible = rs.filter((r) => r.holdOut !== 'n/a');
      const holdOutPass = holdOutEligible.filter((r) => r.holdOut === 'pass').length;
      const domain = rs[0]!.domain;
      const difficulty = rs[0]!.difficulty;
      const classifications = [...new Set(rs.map((r) => r.classification))].join(', ');
      return [name, domain, difficulty, pct(met, n), pct(holdOutPass, holdOutEligible.length), classifications];
    });
  lines.push(markdownTable(['Case', 'Domain', 'Difficulty', 'Expectation met', 'Hold-out pass', 'Classifications seen'], caseRows));
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CSV (one row per run)
// ---------------------------------------------------------------------------

const CSV_COLUMNS: (keyof RunRecord)[] = [
  'case',
  'domain',
  'difficulty',
  'model',
  'masking',
  'run',
  'path',
  'classification',
  'expectationMet',
  'holdOut',
  'fastPath',
  'schemaValid',
  'verifiedFirstCall',
  'verifiedAfterRepair',
  'tokensIn',
  'tokensOut',
  'tokensCached',
  'costUsd',
  'latencyMs',
  'llmCalls',
  'error',
];

export function buildCsvReport(records: RunRecord[]): string {
  const header = CSV_COLUMNS.join(',');
  const rows = records.map((r) => CSV_COLUMNS.map((c) => csvCell(c === 'features' ? r.features.join('|') : r[c])).join(','));
  return [header, ...rows].join('\n') + '\n';
}

/** A short stdout summary (SPEC 10: "Print a short summary to stdout."). */
export function printSummary(records: RunRecord[], log: (line: string) => void = console.log): void {
  log(`\n${records.length} runs across ${new Set(records.map((r) => r.case)).size} cases.`);
  for (const g of groupSummaries(records)) {
    log(
      `  ${g.model} masking=${g.masking ? 'on' : 'off'}: blocked ${g.shareBlocked}, fast path ${g.shareFastPath}, ` +
        `expectation met ${g.expectationMet}, hold-out ${g.holdOutPassRate}, verified 1st/after-repair ${g.verifiedFirstCall}/${g.verifiedAfterRepair}, ` +
        `cost/learn $${g.costPerLearnUsd.toFixed(4)}`,
    );
  }
  const failed = records.filter((r) => !r.expectationMet);
  if (failed.length > 0) {
    log(`  ${failed.length} run(s) did not meet expectation - see the report for details.`);
  }
}
