// SPEC 10 report: markdown + CSV, per model x masking mode, plus failures grouped by
// feature/reason code/domain and a per-case table. `results.csv` carries one row per
// individual run (case x model x masking x run) for anyone who wants to slice the raw
// data themselves; the markdown carries the aggregates a human actually reads.
import type { EvalMode } from './args.js';
import { formulaErrorMessagesByRecord, type RunRecord } from './runner.js';

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
  /** Set only when the run had more than one mode (see `RunRecord.mode`). */
  mode?: EvalMode;
  /** Average size of the payload sent to the AI step, in KB (runs that made a call only). Set only with modes. */
  avgPayloadKb?: number;
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
  /** Product tracking (SPEC 9.2's `formula`-kind `RepairProblem`): how often models
   * write invalid formula text. */
  formulaErrorsPerCall: number;
  shareLearnsWithFormulaError: string;
  formulaFixedByRepairShare: string;
}

/** The run tagged its records with a mode (it ran `complete`, alone or next to `full`): the report then shows the mode everywhere. */
function isTagged(records: readonly RunRecord[]): boolean {
  return records.some((r) => r.mode !== undefined);
}

function groupKey(model: string, masking: boolean, mode?: EvalMode): string {
  return `${model}\u0000${masking ? 'on' : 'off'}${mode ? `\u0000${mode}` : ''}`;
}

function summarizeGroup(model: string, masking: boolean, records: readonly RunRecord[], mode?: EvalMode): GroupSummary {
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

  const totalLlmCalls = llmRuns.reduce((sum, r) => sum + r.llmCalls, 0);
  const totalFormulaErrors = llmRuns.reduce((sum, r) => sum + r.formulaErrorCount, 0);
  const withFormulaError = llmRuns.filter((r) => r.firstCallFormulaErrors > 0);
  const fixedByRepair = withFormulaError.filter((r) => r.formulaFixedByRepair);

  const withPayload = records.filter((r) => (r.payloadBytes ?? 0) > 0);
  return {
    model,
    masking,
    ...(mode ? { mode, avgPayloadKb: avg(withPayload.map((r) => (r.payloadBytes ?? 0) / 1024)) } : {}),
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
    formulaErrorsPerCall: totalLlmCalls === 0 ? 0 : totalFormulaErrors / totalLlmCalls,
    shareLearnsWithFormulaError: pct(withFormulaError.length, llmRuns.length),
    formulaFixedByRepairShare: pct(fixedByRepair.length, withFormulaError.length),
  };
}

function groupSummaries(records: readonly RunRecord[]): GroupSummary[] {
  const groups = new Map<string, RunRecord[]>();
  const tagged = isTagged(records);
  for (const r of records) {
    const key = groupKey(r.model, r.masking, tagged ? (r.mode ?? 'full') : undefined);
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }
  const out: GroupSummary[] = [];
  for (const [key, list] of groups) {
    const [model, maskingLabel, mode] = key.split('\u0000') as [string, string, EvalMode | undefined];
    out.push(summarizeGroup(model, maskingLabel === 'on', list, mode));
  }
  out.sort((a, b) => a.model.localeCompare(b.model) || Number(a.masking) - Number(b.masking) || (a.mode ?? '').localeCompare(b.mode ?? ''));
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

/** Tallies every formula-parse-error MESSAGE seen across all records (via the dev-only
 * `formulaErrorMessagesByRecord`, SPEC 15: message text never goes through the
 * production ledger), most common first - for the "top formula error messages" section.
 * A message is syntax-only (e.g. "expected \")\" at 17"), never user data. */
function tallyFormulaErrorMessages(records: readonly RunRecord[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const r of records) {
    const messages = formulaErrorMessagesByRecord.get(r);
    if (!messages) continue;
    for (const m of messages) counts.set(m, (counts.get(m) ?? 0) + 1);
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

// ---------------------------------------------------------------------------
// Completion mode: what the AI step was left to do, and full vs completion side by side
// ---------------------------------------------------------------------------

const kb = (bytes: number | undefined): string => ((bytes ?? 0) / 1024).toFixed(1);

function labelOf(rs: readonly RunRecord[]): string {
  return [...new Set(rs.map((r) => r.classification))].join(', ');
}

function tokensOf(rs: readonly RunRecord[]): string {
  return `${avg(rs.map((r) => r.tokensIn)).toFixed(0)} / ${avg(rs.map((r) => r.tokensOut)).toFixed(0)}`;
}

/** Per case: what each mode made of it, tokens and payload size next to each other (the fast path and blocked cases need no AI step in either). */
function completionSection(records: readonly RunRecord[]): string[] {
  const lines: string[] = [];
  const byCase = new Map<string, { full: RunRecord[]; complete: RunRecord[] }>();
  for (const r of records) {
    const entry = byCase.get(r.case) ?? { full: [], complete: [] };
    (r.mode === 'complete' ? entry.complete : entry.full).push(r);
    byCase.set(r.case, entry);
  }
  const both = records.some((r) => r.mode === 'complete') && records.some((r) => r.mode === 'full');
  const names = [...byCase.keys()].sort((a, b) => a.localeCompare(b));

  if (both) {
    lines.push(
      '## Full vs completion (side by side)',
      '',
      'Completion runs the local partial result first (no LLM), keeps it as a fixed part, and asks the AI step only for what is missing. Tokens are in / out per learn (0 when no call was made); payload is the first payload sent. Attach cases always run full.',
      '',
      markdownTable(
        ['Case', 'Full: result', 'Full: payload KB', 'Full: tok in / out', 'Full: LLM calls', 'Complete: result', 'Complete: fixed cols', 'Complete: missing cols / parts', 'Complete: payload KB', 'Complete: tok in / out', 'Complete: LLM calls'],
        names.map((name) => {
          const { full, complete } = byCase.get(name)!;
          const c0 = complete[0];
          return [
            name,
            labelOf(full) || '-',
            kb(avg(full.map((r) => r.payloadBytes ?? 0))),
            tokensOf(full),
            avg(full.map((r) => r.llmCalls)).toFixed(1),
            labelOf(complete) || '-',
            c0?.fixedColumns ?? '-',
            c0 ? `${c0.missingColumns ?? 0} / ${c0.missingParts ?? 0}${c0.completionSkipped ? ` (${c0.completionSkipped})` : ''}` : '-',
            kb(avg(complete.map((r) => r.payloadBytes ?? 0))),
            tokensOf(complete),
            avg(complete.map((r) => r.llmCalls)).toFixed(1),
          ];
        }),
      ),
      '',
    );
  } else {
    lines.push(
      '## Completion details',
      '',
      'The local partial result is kept as a fixed part; the AI step is asked only for the missing columns and layout parts.',
      '',
      markdownTable(
        ['Case', 'Result', 'Fixed cols', 'Missing cols', 'Missing parts', 'Note', 'Payload KB', 'LLM calls', 'Tok in / out'],
        names.map((name) => {
          const rs = byCase.get(name)!.complete;
          const r0 = rs[0];
          return [name, labelOf(rs) || '-', r0?.fixedColumns ?? '-', r0?.missingColumns ?? '-', r0?.missingParts ?? '-', r0?.completionSkipped ?? '', kb(avg(rs.map((r) => r.payloadBytes ?? 0))), avg(rs.map((r) => r.llmCalls)).toFixed(1), tokensOf(rs)];
        }),
      ),
      '',
    );
  }
  return lines;
}

export function buildMarkdownReport(records: RunRecord[], generatedAt: string): string {
  const lines: string[] = [];
  lines.push('# Model evaluation report (SPEC 10)', '', `Generated: ${generatedAt}`, `Total runs: ${records.length}`, '');

  lines.push('## Per model x masking', '');
  const groups = groupSummaries(records);
  const tagged = isTagged(records);
  lines.push(
    markdownTable(
      ['Model', 'Masking', ...(tagged ? ['Mode'] : []), 'n', 'Blocked', 'Fast path', 'Schema-valid', 'Verified (1st call)', 'Verified (after repair)', 'Expectation met', 'Hold-out pass', 'Avg tok in', 'Avg tok out', 'Avg tok cached', ...(tagged ? ['Avg payload (KB)'] : []), 'Cost/learn (USD)', 'Avg latency (ms)', 'Formula err/call', 'Learns w/ formula err', 'Fixed by repair'],
      groups.map((g) => [
        g.model,
        g.masking ? 'on' : 'off',
        ...(tagged ? [g.mode ?? 'full'] : []),
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
        ...(tagged ? [(g.avgPayloadKb ?? 0).toFixed(1)] : []),
        g.costPerLearnUsd.toFixed(4),
        g.avgLatencyMs.toFixed(0),
        g.formulaErrorsPerCall.toFixed(2),
        g.shareLearnsWithFormulaError,
        g.formulaFixedByRepairShare,
      ]),
    ),
  );
  lines.push('');

  lines.push('## Formula errors', '', 'How often models write invalid formula text (learn-v5), and how often a repair call fixes it. Messages are syntax-only (an offset and a parser message) - never user data.', '');
  const topFormulaMessages = tallyFormulaErrorMessages(records);
  lines.push(
    topFormulaMessages.length > 0
      ? markdownTable(['Message', 'Count'], topFormulaMessages.slice(0, 10).map(([msg, n]) => [msg, n]))
      : '(no formula errors in this run)',
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
  const caseKey = (r: RunRecord): string => (tagged ? `${r.case}\u0000${r.mode ?? 'full'}` : r.case);
  for (const r of records) {
    const list = byCase.get(caseKey(r));
    if (list) list.push(r);
    else byCase.set(caseKey(r), [r]);
  }
  const caseRows: (string | number)[][] = [...byCase.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, rs]) => {
      const [name, mode] = key.split('\u0000') as [string, string | undefined];
      const n = rs.length;
      const met = rs.filter((r) => r.expectationMet).length;
      const holdOutEligible = rs.filter((r) => r.holdOut !== 'n/a');
      const holdOutPass = holdOutEligible.filter((r) => r.holdOut === 'pass').length;
      const domain = rs[0]!.domain;
      const difficulty = rs[0]!.difficulty;
      const classifications = [...new Set(rs.map((r) => r.classification))].join(', ');
      return [name, ...(tagged ? [mode ?? 'full'] : []), domain, difficulty, pct(met, n), pct(holdOutPass, holdOutEligible.length), classifications];
    });
  lines.push(markdownTable(['Case', ...(tagged ? ['Mode'] : []), 'Domain', 'Difficulty', 'Expectation met', 'Hold-out pass', 'Classifications seen'], caseRows));
  lines.push('');

  if (tagged) lines.push(...completionSection(records));

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
  'formulaErrorCount',
  'firstCallFormulaErrors',
  'formulaFixedByRepair',
  'error',
];

/** Only when the run had modes (see `isTagged`): a full-only results.csv keeps exactly the columns it always had. */
const MODE_CSV_COLUMNS: (keyof RunRecord)[] = ['mode', 'payloadBytes', 'fixedColumns', 'missingColumns', 'missingParts', 'completionSkipped'];

export function buildCsvReport(records: RunRecord[]): string {
  const columns: (keyof RunRecord)[] = isTagged(records) ? [...CSV_COLUMNS.slice(0, -1), ...MODE_CSV_COLUMNS, 'error'] : CSV_COLUMNS;
  const header = columns.join(',');
  const rows = records.map((r) => columns.map((c) => csvCell(c === 'features' ? r.features.join('|') : r[c])).join(','));
  return [header, ...rows].join('\n') + '\n';
}

/** A short stdout summary (SPEC 10: "Print a short summary to stdout."). */
export function printSummary(records: RunRecord[], log: (line: string) => void = console.log): void {
  log(`\n${records.length} runs across ${new Set(records.map((r) => r.case)).size} cases.`);
  for (const g of groupSummaries(records)) {
    log(
      `  ${g.model} masking=${g.masking ? 'on' : 'off'}${g.mode ? ` mode=${g.mode}` : ''}: blocked ${g.shareBlocked}, fast path ${g.shareFastPath}, ` +
        `expectation met ${g.expectationMet}, hold-out ${g.holdOutPassRate}, verified 1st/after-repair ${g.verifiedFirstCall}/${g.verifiedAfterRepair}, ` +
        `cost/learn $${g.costPerLearnUsd.toFixed(4)}, formula errs/call ${g.formulaErrorsPerCall.toFixed(2)} (${g.shareLearnsWithFormulaError} of learns, ${g.formulaFixedByRepairShare} fixed by repair)`,
    );
  }
  const failed = records.filter((r) => !r.expectationMet);
  if (failed.length > 0) {
    log(`  ${failed.length} run(s) did not meet expectation - see the report for details.`);
  }
}
