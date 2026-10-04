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
// Token usage and cost: OUR OWN estimate (learning-loop proposal, section 4)
// ---------------------------------------------------------------------------

/** The learns that made at least one LLM call: the ones that cost anything (the free engine's learns and blocked cases cost nothing). */
function aiLearns(records: readonly RunRecord[]): RunRecord[] {
  return records.filter((r) => r.llmCalls > 0);
}

/** An estimated cost, or null when ANY of them is null (a model with no price: the total is unknown, never a guess). */
function sumCost(values: readonly (number | null)[]): number | null {
  let total = 0;
  for (const v of values) {
    if (v === null) return null;
    total += v;
  }
  return total;
}

const usd = (v: number | null): string => (v === null ? 'n/a' : v.toFixed(4));
const secondsOf = (ms: number): string => (ms / 1000).toFixed(1);

/** How the learning loops ended, tallied, most common first ("verified 3, noProgress 1"); '-' when none ran. */
function loopEnds(records: readonly RunRecord[]): string {
  const counts = new Map<string, number>();
  for (const r of records) if (r.loopEnd) counts.set(r.loopEnd, (counts.get(r.loopEnd) ?? 0) + 1);
  const list = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return list.length === 0 ? '-' : list.map(([end, n]) => `${end} ${n}`).join(', ');
}

interface UsageTotals {
  learns: number;
  calls: number;
  /** The learning loop: rounds made and rows they sent, over these learns, and how each loop ended (`loopEnd`, tallied). */
  rounds: number;
  rowsSent: number;
  ends: string;
  inTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  outTokens: number;
  costUsd: number | null;
  latencyMs: number;
  verified: number;
  holdOutEligible: number;
  holdOutPass: number;
}

/** Totals over the learns that made an LLM call (an average is the total over `learns`). */
function usageOf(records: readonly RunRecord[]): UsageTotals {
  const rs = aiLearns(records);
  const holdOutEligible = rs.filter((r) => r.holdOut !== 'n/a');
  return {
    learns: rs.length,
    calls: rs.reduce((n, r) => n + r.llmCalls, 0),
    rounds: rs.reduce((n, r) => n + r.loopRounds, 0),
    rowsSent: rs.reduce((n, r) => n + r.loopRowsSent, 0),
    ends: loopEnds(rs),
    inTokens: rs.reduce((n, r) => n + r.estInTokens, 0),
    cachedTokens: rs.reduce((n, r) => n + r.estCachedTokens, 0),
    cacheWriteTokens: rs.reduce((n, r) => n + r.estCacheWriteTokens, 0),
    outTokens: rs.reduce((n, r) => n + r.estOutTokens, 0),
    costUsd: sumCost(rs.map((r) => r.estCostUsd)),
    latencyMs: rs.reduce((n, r) => n + r.latencyMs, 0),
    verified: rs.filter((r) => r.classification === 'verified').length,
    holdOutEligible: holdOutEligible.length,
    holdOutPass: holdOutEligible.filter((r) => r.holdOut === 'pass').length,
  };
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
  /** Our own token estimate over the learns that made an LLM call. */
  usage: UsageTotals;
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
    usage: usageOf(records),
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

/** Per model x masking (x mode): the totals and the average per learn, then every learn that made an LLM call, one row each. */
function usageSection(records: readonly RunRecord[], groups: readonly GroupSummary[], tagged: boolean): string[] {
  const lines: string[] = ['## Token usage and cost (our own estimate)', ''];
  lines.push(
    'Counted by us from the exact text sent and received, NOT reported by the provider (the dev CLI\'s own numbers include Claude Code\'s overhead and thinking tokens): ' +
      'the system prompt and the schema are the cached prefix - written by the first call of a learn (cache write), read by every later call of it (cached); the rest of the input is full price; ' +
      '~4 characters per token (~2 for non-ASCII), priced with the providers\' published prices (`packages/shared/src/config/pricing.ts`). ' +
      'An estimate for comparing a run with an earlier one, not a bill; "n/a" = a model with no price. Only learns that made at least one LLM call are counted (the free engine costs nothing).',
    '',
  );
  const shown = groups.filter((g) => g.usage.learns > 0);
  if (shown.length === 0) {
    lines.push('(no LLM call in this run)', '');
    return lines;
  }
  lines.push(
    'Loop rounds and rows sent are the learning loop\'s (SPEC 9.3): browser-triggered repair rounds after the full verification, each sending rows of the example the rules got wrong; the loop ends verified, or on a stop (noProgress, roundCap, rowCap, payloadCap, nothingToSend).',
    '',
  );
  const head = ['Model', 'Masking', ...(tagged ? ['Mode'] : []), 'Basis', 'AI learns', 'LLM calls', 'Loop rounds', 'Rows sent', 'Loop ends', 'Est. tok in', 'Est. tok cached', 'Est. tok cache write', 'Est. tok out', 'Est. cost (USD)', 'Latency (s)', 'Verified on example', 'Hold-out pass'];
  const rows: (string | number)[][] = [];
  for (const g of shown) {
    const u = g.usage;
    const lead = [g.model, g.masking ? 'on' : 'off', ...(tagged ? [g.mode ?? 'full'] : [])];
    rows.push([...lead, 'total', u.learns, u.calls, u.rounds, u.rowsSent, u.ends, u.inTokens, u.cachedTokens, u.cacheWriteTokens, u.outTokens, usd(u.costUsd), secondsOf(u.latencyMs), `${u.verified} of ${u.learns}`, `${u.holdOutPass} of ${u.holdOutEligible}`]);
    rows.push([...lead, 'average per learn', '', (u.calls / u.learns).toFixed(2), (u.rounds / u.learns).toFixed(2), (u.rowsSent / u.learns).toFixed(1), '', (u.inTokens / u.learns).toFixed(0), (u.cachedTokens / u.learns).toFixed(0), (u.cacheWriteTokens / u.learns).toFixed(0), (u.outTokens / u.learns).toFixed(0), usd(u.costUsd === null ? null : u.costUsd / u.learns), secondsOf(u.latencyMs / u.learns), pct(u.verified, u.learns), pct(u.holdOutPass, u.holdOutEligible)]);
  }
  lines.push(markdownTable(head, rows), '');

  lines.push('### Per learn', '');
  const learns = aiLearns(records).sort((a, b) => a.case.localeCompare(b.case) || a.model.localeCompare(b.model) || Number(a.masking) - Number(b.masking) || a.run - b.run || (a.mode ?? '').localeCompare(b.mode ?? ''));
  lines.push(
    markdownTable(
      ['Case', ...(tagged ? ['Mode'] : []), 'Model', 'Masking', 'Run', 'LLM calls', 'Loop rounds', 'Rows sent', 'Loop end', 'Est. tok in', 'Est. tok cached', 'Est. tok cache write', 'Est. tok out', 'Est. cost (USD)', 'Latency (s)', 'Verified on example', 'Hold-out'],
      learns.map((r) => [r.case, ...(tagged ? [r.mode ?? 'full'] : []), r.model, r.masking ? 'on' : 'off', r.run, r.llmCalls, r.loopRounds, r.loopRowsSent, r.loopEnd || '-', r.estInTokens, r.estCachedTokens, r.estCacheWriteTokens, r.estOutTokens, usd(r.estCostUsd), secondsOf(r.latencyMs), r.classification === 'verified' ? 'yes' : 'no', r.holdOut === 'n/a' ? '-' : r.holdOut]),
    ),
    '',
  );
  return lines;
}

/** Cases whose `meta.expectNote` says more than `expect` can: what the expected outcome means (printed, not scored). */
function expectNotesSection(records: readonly RunRecord[]): string[] {
  const notes = new Map<string, string>();
  for (const r of records) if (r.expectNote) notes.set(r.case, r.expectNote);
  if (notes.size === 0) return [];
  return ['## Expected outcomes in words', '', 'Not scored: "expectation met" is still decided by the case\'s expect; this is what the case is really after.', '', markdownTable(['Case', 'Expected outcome'], [...notes.entries()].sort((a, b) => a[0].localeCompare(b[0]))), ''];
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

  lines.push(...usageSection(records, groups, tagged));

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

  lines.push(...expectNotesSection(records));

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
  'estInTokens',
  'estCachedTokens',
  'estCacheWriteTokens',
  'estOutTokens',
  'estCostUsd',
  'loopRounds',
  'loopRowsSent',
  'loopEnd',
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
        `provider-reported cost/learn $${g.costPerLearnUsd.toFixed(4)}, formula errs/call ${g.formulaErrorsPerCall.toFixed(2)} (${g.shareLearnsWithFormulaError} of learns, ${g.formulaFixedByRepairShare} fixed by repair)`,
    );
    const u = g.usage;
    if (u.learns > 0) {
      const per = (n: number): string => (n / u.learns).toFixed(0);
      const money = (v: number | null): string => (v === null ? 'n/a' : `$${v.toFixed(4)}`);
      log(
        `    est. tokens (our own count) over ${u.learns} AI learn(s), ${u.calls} call(s): in ${u.inTokens} / cached ${u.cachedTokens} / cache write ${u.cacheWriteTokens} / out ${u.outTokens}, est. cost ${money(u.costUsd)}, ${secondsOf(u.latencyMs)} s; ` +
          `per learn: in ${per(u.inTokens)} / cached ${per(u.cachedTokens)} / cache write ${per(u.cacheWriteTokens)} / out ${per(u.outTokens)}, est. cost ${money(u.costUsd === null ? null : u.costUsd / u.learns)}, ${secondsOf(u.latencyMs / u.learns)} s; ` +
          `loop: ${u.rounds} round(s), ${u.rowsSent} row(s) sent, ends ${u.ends}; ` +
          `verified on example ${u.verified} of ${u.learns}, hold-out ${u.holdOutPass} of ${u.holdOutEligible}`,
      );
    }
  }
  const failed = records.filter((r) => !r.expectationMet);
  if (failed.length > 0) {
    log(`  ${failed.length} run(s) did not meet expectation - see the report for details.`);
  }
}
