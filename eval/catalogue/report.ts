// Turns the measurement records into the capability map (report.md) and a flat CSV. Pure functions over `CatalogueRecord[]`.
// With AI results in the records (`run-catalogue.ts --ai <model>`, see ai.ts) the report gains the "AI learns it" column and an AI section;
// without any, nothing about the report differs from the free-run report.
import { aiConfigKey, aiStatusOf, estimateTotals, type AiStatus } from './aiRecords';
import { CAPABILITIES, CAPABILITY_FAMILY_TITLES, type CapabilityId } from './capabilities';
import { TOPICS, TOPIC_TITLES, type AiRecord, type CatalogueRecord, type FastStatus, type TopicId } from './types';

// ---------- Per-type summary ----------

export type LanguageStatus = 'ok' | 'gap' | 'broken';

export interface TypeSummary {
  type: string;
  topic: TopicId;
  title: string;
  lang: 'he' | 'en';
  seeds: number[];
  language: LanguageStatus;
  capability?: CapabilityId;
  languageDetail: string;
  workaround?: string;
  /** Worst fast status over the seeds. */
  fast: FastStatus;
  /** Every seed has the same fast status. */
  fastStable: boolean;
  fastDetail: string;
  /** What the strict/partial builder produced when it was wrong (overfit/unverified), or what it solved. */
  learned: string;
  /** How the unsolved columns are classified (empty when the fast engine solved everything). */
  unsolved: string;
  /** Reasons the type is not solved by the fast engine, one short code per distinct reason (for the grouping). */
  fastReasons: string[];
  holdOut: 'pass' | 'fail' | 'n/a' | 'mixed';
  /** The strict path declined but the partial builder produced a complete, verified rules file. */
  viaPartial: boolean;
  /** Expressible, but the free engine does not solve it on every seed: the types the AI step has to learn. */
  needsAi: boolean;
  /** The AI layer over the seeds that were measured; undefined when none was (the free-run report, or a needs-AI type not run yet). */
  ai?: AiTypeSummary;
}

/** What the AI step did on one type, over its measured seeds. The worst seed counts; a seed whose measurement errored is not an answer and is left
 * out (unless every seed errored). */
export interface AiTypeSummary {
  status: AiStatus;
  /** Every answering seed has the same status. */
  stable: boolean;
  /** Seeds measured / seeds of the type in the file. */
  seeds: number;
  of: number;
  records: AiRecord[];
  /** The record that decided `status`. */
  worst: AiRecord;
}

export interface TopicSummary {
  topic: TopicId;
  types: number;
  languageOk: number;
  languageGap: number;
  languageBroken: number;
  fastSolved: number;
  fastPartial: number;
  fastNone: number;
  /** overfit + unverified: the fast engine produced rules that are wrong. */
  fastWrong: number;
  /** Expressible, but the fast engine does not finish it: the AI step is needed. */
  needsAi: number;
}

export interface GapSummary {
  capability: CapabilityId;
  types: string[];
}

export interface DetectionGap {
  reason: string;
  types: string[];
}

export interface ColumnClass {
  cls: string;
  columns: number;
  types: string[];
}

export interface Totals {
  types: number;
  languageOk: number;
  languageGap: number;
  languageBroken: number;
  fastSolved: number;
  fastPartial: number;
  fastNone: number;
  fastOverfit: number;
  fastUnverified: number;
}

/** The AI step's numbers for a group of types (a topic, or all). Shares and the type counts are per type; the averages are per measured (type, seed). */
export interface AiGroupStats {
  label: string;
  /** Types that need the AI step / of them: measured (at least one seed answered) / not run yet. */
  needsAi: number;
  run: number;
  notRun: number;
  learned: number;
  verifiedOnly: number;
  failed: number;
  /** Types whose every measured seed errored. */
  errors: number;
  /** learned / (learned + verifiedOnly + failed); 0 when none was run. */
  share: number;
  /** Measured (type, seed) pairs that answered (errors left out). */
  records: number;
  avgCalls: number;
  avgTokensIn: number;
  avgTokensOut: number;
  avgTokensCached: number;
  avgLatencyMs: number;
  /** Our own token estimate over the answered records that carry one (`records` of them): the total; a mean per record is the total over `records`. */
  est: { records: number; inTokens: number; cachedTokens: number; cacheWriteTokens: number; outTokens: number; costUsd: number | null };
  formulaErrors: number;
  /** The AI's unsupported codes / the functions it asked for, most frequent first; records with an explanation. */
  unsupported: [string, number][];
  functionRequests: [string, number][];
  explanations: number;
}

export interface AiSummary {
  /** Every configuration the file holds AI results for, with the number of records. */
  configs: { key: string; provider: string; records: number }[];
  topics: AiGroupStats[];
  total: AiGroupStats;
  /** Needs-AI types with no AI result yet. */
  notRun: string[];
  /** Function name -> the types whose answer asked for it. */
  functionRequests: { name: string; types: string[] }[];
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  costUsd: number;
  /** Our own token estimate over every measurement that carries one. */
  est: AiGroupStats['est'];
  latencyMs: number;
}

export interface Summary {
  types: TypeSummary[];
  topics: TopicSummary[];
  gaps: GapSummary[];
  detectionGaps: DetectionGap[];
  columnClasses: ColumnClass[];
  /** Things worth a look: wrong results, catalogue bugs, odd disagreements between the two layers. */
  surprises: string[];
  totals: Totals;
  records: CatalogueRecord[];
  /** Present only when some record carries an AI result. */
  ai?: AiSummary;
}

const BADNESS: Record<FastStatus, number> = { solved: 0, partial: 1, none: 2, unverified: 3, overfit: 4 };

function groupBy<T>(items: readonly T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    const arr = m.get(k);
    if (arr) arr.push(it);
    else m.set(k, [it]);
  }
  return m;
}

function columnClassOf(u: CatalogueRecord['fast']['unsolved'][number]): string {
  if (u.cls === 'external') return 'column external: nothing in the input explains it';
  if (u.cls === 'derived') return `column derived/${u.hint}: code sees the dependency, cannot write the rule`;
  return `column related/${u.hint} declined: ${u.reason}`;
}

/** The short reasons a record is not a clean fast-engine solve. */
function reasonsOf(r: CatalogueRecord): string[] {
  const f = r.fast;
  if (f.status === 'solved') return [];
  if (f.status === 'overfit') return ['overfit: verified on the example, wrong on the next file'];
  if (f.status === 'unverified') return ["local rules fail the engine's own verification"];
  const out = new Set<string>();
  if (f.path === 'blocked' || f.path === 'notReady') out.add(`blocked: ${f.blockedBy.join('+') || 'unknown'}`);
  if (f.path === 'error') out.add(`error: ${f.error ?? ''}`.slice(0, 80));
  for (const u of f.unsolved) out.add(columnClassOf(u));
  for (const part of f.needsAiParts) out.add(`layout: ${part}`);
  if (out.size === 0 && f.fastReason) out.add(`strict path: ${f.fastReason}`);
  if (out.size === 0) out.add('other');
  return [...out];
}

function describeUnsolved(r: CatalogueRecord): string {
  const f = r.fast;
  const parts = f.unsolved.map((u) => {
    if (u.cls === 'external') return `${u.header}: external`;
    if (u.cls === 'derived') return `${u.header}: derived/${u.hint}`;
    return `${u.header}: ${u.relations.length > 0 ? u.relations.join(',') : u.hint} declined (${u.reason})`;
  });
  if (f.needsAiParts.length > 0) parts.push(`layout: ${f.needsAiParts.join('+')}`);
  if (parts.length === 0 && f.blockedBy.length > 0) parts.push(`blocked: ${f.blockedBy.join('+')}`);
  return parts.join('; ');
}

function fastDetailOf(r: CatalogueRecord): string {
  const f = r.fast;
  switch (f.status) {
    case 'solved':
      return f.totalColumns > 0 ? `${f.solvedColumns.length}/${f.totalColumns} columns` : '';
    case 'overfit':
    case 'unverified':
      return f.holdOutDetail ?? '';
    default:
      if (f.path === 'blocked' || f.path === 'notReady') return `blocked: ${f.blockedBy.join('+') || 'unknown'}`;
      if (f.path === 'error') return f.error ?? 'error';
      return `${f.solvedColumns.length}/${f.totalColumns} columns`;
  }
}

const AI_BADNESS: Record<AiStatus, number> = { learned: 0, verifiedOnly: 1, failed: 2, error: 3 };

function aiOf(recs: CatalogueRecord[]): AiTypeSummary | undefined {
  const records = recs.flatMap((r) => (r.ai ? [r.ai] : []));
  if (records.length === 0) return undefined;
  const answered = records.filter((a) => aiStatusOf(a) !== 'error');
  const pool = answered.length > 0 ? answered : records;
  const worst = pool.reduce((x, y) => (AI_BADNESS[aiStatusOf(y)] > AI_BADNESS[aiStatusOf(x)] ? y : x));
  return { status: aiStatusOf(worst), stable: pool.every((a) => aiStatusOf(a) === aiStatusOf(pool[0]!)), seeds: records.length, of: recs.length, records, worst };
}

function tally(items: readonly string[]): [string, number][] {
  const m = new Map<string, number>();
  for (const it of items) m.set(it, (m.get(it) ?? 0) + 1);
  return [...m].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]));
}

function estOf(records: readonly AiRecord[]): AiGroupStats['est'] {
  const { records: n, total } = estimateTotals(records);
  return { records: n, inTokens: total.inputTokens, cachedTokens: total.cachedInputTokens, cacheWriteTokens: total.cacheWriteTokens, outTokens: total.outputTokens, costUsd: total.costUsd };
}

function aiGroup(label: string, ts: TypeSummary[]): AiGroupStats {
  const run = ts.filter((t) => t.ai !== undefined && t.ai.status !== 'error');
  const count = (st: AiStatus): number => ts.filter((t) => t.ai?.status === st).length;
  const learned = count('learned');
  const verifiedOnly = count('verifiedOnly');
  const failed = count('failed');
  const answered = ts.flatMap((t) => (t.ai?.records ?? []).filter((a) => aiStatusOf(a) !== 'error'));
  const avg = (f: (a: AiRecord) => number): number => (answered.length === 0 ? 0 : answered.reduce((n, a) => n + f(a), 0) / answered.length);
  return {
    label,
    needsAi: ts.filter((t) => t.needsAi).length,
    run: run.length,
    notRun: ts.filter((t) => t.needsAi && t.ai === undefined).length,
    learned,
    verifiedOnly,
    failed,
    errors: count('error'),
    share: learned + verifiedOnly + failed === 0 ? 0 : learned / (learned + verifiedOnly + failed),
    records: answered.length,
    avgCalls: avg((a) => a.llmCalls),
    avgTokensIn: avg((a) => a.tokensIn),
    avgTokensOut: avg((a) => a.tokensOut),
    avgTokensCached: avg((a) => a.tokensCached),
    avgLatencyMs: avg((a) => a.latencyMs),
    est: estOf(answered),
    formulaErrors: answered.reduce((n, a) => n + a.formulaErrors, 0),
    unsupported: tally(answered.flatMap((a) => a.unsupported)),
    functionRequests: tally(answered.flatMap((a) => a.functionRequests)),
    explanations: answered.filter((a) => a.explanation).length,
  };
}

function aiSummary(types: TypeSummary[], records: CatalogueRecord[]): AiSummary | undefined {
  if (!records.some((r) => r.ai)) return undefined;
  const configs = new Map<string, { key: string; provider: string; records: number }>();
  for (const r of records) {
    if (!r.ai) continue;
    const key = aiConfigKey(r.ai);
    const c = configs.get(key) ?? { key, provider: r.ai.provider, records: 0 };
    c.records++;
    configs.set(key, c);
  }
  const all = records.flatMap((r) => (r.ai ? [r.ai] : []));
  const requests = new Map<string, Set<string>>();
  for (const t of types) for (const a of t.ai?.records ?? []) for (const name of a.functionRequests) requests.set(name, (requests.get(name) ?? new Set<string>()).add(t.type));
  return {
    configs: [...configs.values()],
    topics: TOPICS.map((topic) => aiGroup(TOPIC_TITLES[topic], types.filter((t) => t.topic === topic))).filter((g) => g.needsAi > 0 || g.run > 0 || g.errors > 0),
    total: aiGroup('All', types),
    notRun: types.filter((t) => t.needsAi && t.ai === undefined).map((t) => t.type),
    functionRequests: [...requests].map(([name, ts]) => ({ name, types: [...ts] })).sort((x, y) => y.types.length - x.types.length || x.name.localeCompare(y.name)),
    tokensIn: all.reduce((n, a) => n + a.tokensIn, 0),
    tokensOut: all.reduce((n, a) => n + a.tokensOut, 0),
    tokensCached: all.reduce((n, a) => n + a.tokensCached, 0),
    costUsd: all.reduce((n, a) => n + a.costUsd, 0),
    est: estOf(all),
    latencyMs: all.reduce((n, a) => n + a.latencyMs, 0),
  };
}

export function summarize(records: CatalogueRecord[]): Summary {
  const byType = groupBy(records, (r) => r.type);
  const types: TypeSummary[] = [];
  for (const [type, recs] of byType) {
    const first = recs[0]!;
    const lang = first.language;
    const language: LanguageStatus = !lang.expressible ? 'gap' : recs.every((r) => r.language.valid && r.language.reproduces) ? 'ok' : 'broken';
    const brokenRec = recs.find((r) => !r.language.valid || !r.language.reproduces);
    const worst = recs.reduce((a, b) => (BADNESS[b.fast.status] > BADNESS[a.fast.status] ? b : a));
    const holdOuts = new Set(recs.map((r) => r.fast.holdOut));
    const holdOut: TypeSummary['holdOut'] = holdOuts.size === 1 ? [...holdOuts][0]! : 'mixed';
    const summary: TypeSummary = {
      type,
      topic: first.topic,
      title: first.title,
      lang: first.lang,
      seeds: recs.map((r) => r.seed),
      language,
      languageDetail: language === 'gap' ? (lang.missingDetail ?? '') : language === 'broken' ? `${brokenRec?.language.problems?.join(' | ') || brokenRec?.language.mismatch || ''}` : '',
      fast: worst.fast.status,
      fastStable: recs.every((r) => r.fast.status === first.fast.status),
      fastDetail: fastDetailOf(worst),
      learned: worst.fast.how ?? '',
      unsolved: describeUnsolved(worst),
      fastReasons: [...new Set(recs.flatMap(reasonsOf))],
      holdOut,
      viaPartial: recs.every((r) => r.fast.viaPartial === true),
      needsAi: language === 'ok' && recs.some((r) => r.fast.status !== 'solved'),
    };
    if (lang.capability !== undefined) summary.capability = lang.capability;
    if (lang.workaround !== undefined) summary.workaround = lang.workaround;
    const ai = aiOf(recs);
    if (ai !== undefined) summary.ai = ai;
    types.push(summary);
  }
  types.sort((a, b) => TOPICS.indexOf(a.topic) - TOPICS.indexOf(b.topic));

  const topics: TopicSummary[] = TOPICS.map((topic) => {
    const ts = types.filter((t) => t.topic === topic);
    return {
      topic,
      types: ts.length,
      languageOk: ts.filter((t) => t.language === 'ok').length,
      languageGap: ts.filter((t) => t.language === 'gap').length,
      languageBroken: ts.filter((t) => t.language === 'broken').length,
      fastSolved: ts.filter((t) => t.fast === 'solved').length,
      fastPartial: ts.filter((t) => t.fast === 'partial').length,
      fastNone: ts.filter((t) => t.fast === 'none').length,
      fastWrong: ts.filter((t) => t.fast === 'overfit' || t.fast === 'unverified').length,
      needsAi: ts.filter((t) => t.needsAi).length,
    };
  }).filter((t) => t.types > 0);

  const gaps: GapSummary[] = [...groupBy(types.filter((t) => t.language === 'gap'), (t) => t.capability ?? '?')]
    .map(([capability, ts]) => ({ capability: capability as CapabilityId, types: ts.map((t) => t.type) }))
    .sort((a, b) => b.types.length - a.types.length || a.capability.localeCompare(b.capability));

  const detection = new Map<string, string[]>();
  for (const t of types) {
    if (t.language !== 'ok' || t.fast === 'solved') continue;
    for (const reason of t.fastReasons) {
      const arr = detection.get(reason);
      if (arr) arr.push(t.type);
      else detection.set(reason, [t.type]);
    }
  }
  const detectionGaps: DetectionGap[] = [...detection].map(([reason, ts]) => ({ reason, types: ts })).sort((a, b) => b.types.length - a.types.length || a.reason.localeCompare(b.reason));

  // Every unsolved column of the first seed of every type, by how the analysis classified it.
  const columnMap = new Map<string, { columns: number; types: Set<string> }>();
  const seenTypes = new Set<string>();
  for (const r of records) {
    if (seenTypes.has(r.type)) continue;
    seenTypes.add(r.type);
    for (const u of r.fast.unsolved) {
      const key = columnClassOf(u);
      const e = columnMap.get(key) ?? { columns: 0, types: new Set<string>() };
      e.columns++;
      e.types.add(r.type);
      columnMap.set(key, e);
    }
  }
  const columnClasses: ColumnClass[] = [...columnMap].map(([cls, e]) => ({ cls, columns: e.columns, types: [...e.types] })).sort((a, b) => b.columns - a.columns || a.cls.localeCompare(b.cls));

  const surprises: string[] = [];
  for (const t of types) {
    if (t.language === 'broken') surprises.push(`${t.type}: the reference rule does not reproduce the expected output (catalogue bug): ${t.languageDetail}`);
    if (t.language === 'gap' && t.fast === 'solved') surprises.push(`${t.type}: marked inexpressible (${t.capability}) yet the fast engine solved it - check the data (spurious detection) or the gap`);
    if (t.fast === 'overfit') surprises.push(`${t.type}: verified on the example, wrong on the next file - the fast engine built ${t.learned || '(see learned.rules.json with --dump)'}`);
    if (t.fast === 'unverified') surprises.push(`${t.type}: the local path built rules that fail its OWN verification (${t.learned || 'see --dump'})`);
    if (!t.fastStable && (t.fast === 'solved' || t.fast === 'none')) surprises.push(`${t.type}: the fast engine's result differs between seeds (data-dependent detection)`);
  }

  const count = (f: (t: TypeSummary) => boolean): number => types.filter(f).length;
  const ai = aiSummary(types, records);
  return {
    types,
    topics,
    gaps,
    detectionGaps,
    columnClasses,
    surprises,
    totals: {
      types: types.length,
      languageOk: count((t) => t.language === 'ok'),
      languageGap: count((t) => t.language === 'gap'),
      languageBroken: count((t) => t.language === 'broken'),
      fastSolved: count((t) => t.fast === 'solved'),
      fastPartial: count((t) => t.fast === 'partial'),
      fastNone: count((t) => t.fast === 'none'),
      fastOverfit: count((t) => t.fast === 'overfit'),
      fastUnverified: count((t) => t.fast === 'unverified'),
    },
    records,
    ...(ai ? { ai } : {}),
  };
}

// ---------- Markdown ----------

function cell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function languageCell(t: TypeSummary): string {
  if (t.language === 'ok') return '✓';
  if (t.language === 'gap') return `✗ ${t.capability}`;
  return '✗ BROKEN reference';
}

function fastCell(t: TypeSummary): string {
  const stable = t.fastStable ? '' : ' (varies by seed)';
  switch (t.fast) {
    case 'solved':
      return `✓${t.viaPartial ? ' (partial builder, complete)' : ''}${stable}`;
    case 'partial':
      return `partial ${t.fastDetail}${stable}`;
    case 'overfit':
      return `⚠ verified, wrong on next file${stable}`;
    case 'unverified':
      return `⚠ local rules fail own verification${stable}`;
    default:
      return `✗${stable}`;
  }
}

function holdOutCell(t: TypeSummary): string {
  return t.holdOut === 'n/a' ? '—' : t.holdOut === 'pass' ? '✓' : t.holdOut === 'fail' ? '✗' : 'mixed';
}

function unsolvedCell(t: TypeSummary): string {
  if (t.fast === 'solved') return '';
  if (t.fast === 'overfit' || t.fast === 'unverified') return t.learned ? `built: ${t.learned}` : t.fastDetail;
  return t.unsolved || t.fastDetail;
}

function aiCell(t: TypeSummary): string {
  if (t.ai === undefined) return t.needsAi ? 'not run' : '—';
  const a = t.ai;
  const partialSeeds = a.seeds < a.of ? ` (${a.seeds}/${a.of} seeds)` : '';
  const stable = a.stable ? '' : ' (varies by seed)';
  switch (a.status) {
    case 'learned':
      return `✓${stable}${partialSeeds}`;
    case 'verifiedOnly':
      return `~ verified only (hold-out ${a.worst.holdOut === 'n/a' ? 'n/a' : '✗'})${stable}${partialSeeds}`;
    case 'failed':
      return `✗ ${a.worst.classification}${a.worst.path === 'local' ? ' (free engine answered)' : ''}${stable}${partialSeeds}`;
    default:
      return `⚠ measurement error${partialSeeds}`;
  }
}

const pct = (x: number): string => `${Math.round(x * 100)}%`;
const dec = (x: number): string => (Number.isInteger(x) ? String(x) : x.toFixed(1));
const kilo = (x: number): string => (x >= 1000 ? `${(x / 1000).toFixed(1)}k` : dec(Math.round(x * 10) / 10));
const topList = (xs: readonly [string, number][], n = 4): string => (xs.length === 0 ? '—' : xs.slice(0, n).map(([k, c]) => `${k} ×${c}`).join(', ') + (xs.length > n ? `, +${xs.length - n} more` : ''));
const seconds = (ms: number): string => (ms / 1000).toFixed(1);
const money = (v: number | null): string => (v === null ? 'n/a' : `$${v.toFixed(v < 1 ? 4 : 2)}`);

/** The mean per record of an estimate total, as "in / cached / write / out" tokens and the cost ("—" when no record carries one). */
function estCells(e: AiGroupStats['est']): [string, string] {
  if (e.records === 0) return ['—', '—'];
  const mean = (n: number): string => kilo(n / e.records);
  return [`${mean(e.inTokens)} / ${mean(e.cachedTokens)} / ${mean(e.cacheWriteTokens)} / ${mean(e.outTokens)}`, money(e.costUsd === null ? null : e.costUsd / e.records)];
}

/** The AI section of the report (only when the records carry AI results). */
function renderAiSection(s: Summary, ai: AiSummary): string[] {
  const out: string[] = [];
  const g = ai.total;
  out.push('## AI step: what the AI learns that the free engine does not');
  out.push('');
  out.push(
    ai.configs.length === 1
      ? `Model \`${ai.configs[0]!.key}\` (provider \`${ai.configs[0]!.provider}\`): ${ai.configs[0]!.records} (type x seed) measurements.`
      : `Several configurations are mixed in this file (re-run with \`--out\` to keep them apart): ${ai.configs.map((c) => `\`${c.key}\` ${c.records}`).join('; ')}.`,
  );
  out.push('');
  out.push('The real learn flow with the AI step allowed, on the types the language can express and the free engine does not solve. **✓** = verified on the example AND the "next month" file converts exactly; **~** = verified on the example only; **✗** = not verified (wrong rules, columns reported as unsupported, no rules, or the free engine answered first and was wrong). A measurement whose every call failed (rate limit, timeout) is an error, not an answer: it is left out of the shares and `--resume` runs it again.');
  out.push('');
  out.push('| | types |');
  out.push('|---|---|');
  out.push(`| Need the AI step (expressible, not solved by the free engine) | ${g.needsAi} |`);
  out.push(`| AI learns it (✓ verified + hold-out) | ${g.learned} |`);
  out.push(`| AI verified only (~, hold-out fails) | ${g.verifiedOnly} |`);
  out.push(`| AI does not learn it (✗) | ${g.failed} |`);
  if (g.errors > 0) out.push(`| Measurement errors (re-run with \`--resume\`) | ${g.errors} |`);
  out.push(`| Not run yet | ${g.notRun} |`);
  out.push(`| Share learned (of those run) | ${g.learned + g.verifiedOnly + g.failed > 0 ? pct(g.share) : '—'} |`);
  out.push(`| Tokens in / out / cached, all measurements | ${kilo(ai.tokensIn)} / ${kilo(ai.tokensOut)} / ${kilo(ai.tokensCached)} |`);
  if (ai.costUsd > 0) out.push(`| Cost reported by the provider | $${ai.costUsd.toFixed(2)} |`);
  if (ai.est.records > 0) {
    out.push(`| Estimated tokens in / cached / cache write / out, all measurements (our own count) | ${kilo(ai.est.inTokens)} / ${kilo(ai.est.cachedTokens)} / ${kilo(ai.est.cacheWriteTokens)} / ${kilo(ai.est.outTokens)} |`);
    out.push(`| Estimated cost at the published prices, all measurements | ${money(ai.est.costUsd)} |`);
  }
  out.push(`| Time in LLM calls | ${seconds(ai.latencyMs)} s |`);
  out.push('');
  if (ai.notRun.length > 0) {
    out.push(`Not run yet: ${ai.notRun.map((x) => `\`${x}\``).join(', ')}.`);
    out.push('');
  }

  out.push('### By topic');
  out.push('');
  out.push('| Topic | Needs AI | Run | ✓ | ~ | ✗ | Share learned | Avg calls | Avg tokens in / out (cached) | Avg est. tokens in / cached / write / out | Avg est. cost | Avg latency | Formula errors | Top unsupported codes | Function requests (named) | Explained |');
  out.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const x of [...ai.topics, ai.total]) {
    const run = x.learned + x.verifiedOnly + x.failed;
    const tokens = `${kilo(x.avgTokensIn)} / ${kilo(x.avgTokensOut)} (${kilo(x.avgTokensCached)})`;
    const [estTokens, estCost] = estCells(x.est);
    out.push(
      `| ${x === ai.total ? '**All**' : x.label} | ${x.needsAi} | ${run}${x.errors > 0 ? ` (+${x.errors} error)` : ''} | ${x.learned} | ${x.verifiedOnly} | ${x.failed} | ${run > 0 ? pct(x.share) : '—'} | ${run > 0 ? dec(Math.round(x.avgCalls * 10) / 10) : '—'} | ${run > 0 ? tokens : '—'} | ${run > 0 ? estTokens : '—'} | ${run > 0 ? estCost : '—'} | ${run > 0 ? `${seconds(x.avgLatencyMs)} s` : '—'} | ${x.formulaErrors} | ${cell(topList(x.unsupported))} | ${cell(topList(x.functionRequests))} | ${x.explanations} |`,
    );
  }
  out.push('');
  out.push('Shares are per type (a type counts by its worst seed); the averages are per measured (type, seed).');
  out.push('');

  out.push('### Per type');
  out.push('');
  out.push('| Type | AI learns it | Path | Calls | Tokens in / out (cached) | Est. tokens in / cached / write / out | Est. cost | Latency | Formula errors | Unsupported | Function request | Explained |');
  out.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const topic of TOPICS) {
    for (const t of s.types.filter((y) => y.topic === topic && y.ai !== undefined)) {
      const rs = t.ai!.records;
      const mean = (f: (a: AiRecord) => number): number => rs.reduce((n, a) => n + f(a), 0) / rs.length;
      const paths = [...new Set(rs.map((a) => a.path))].join('/');
      const unsupported = [...new Set(rs.flatMap((a) => a.unsupported))].join(', ');
      const requests = [...new Set(rs.flatMap((a) => a.functionRequests))].join(', ');
      const tokens = `${kilo(mean((a) => a.tokensIn))} / ${kilo(mean((a) => a.tokensOut))} (${kilo(mean((a) => a.tokensCached))})`;
      const [estTokens, estCost] = estCells(estOf(rs));
      out.push(
        `| \`${t.type}\` | ${cell(aiCell(t))} | ${paths} | ${dec(Math.round(mean((a) => a.llmCalls) * 10) / 10)} | ${tokens} | ${estTokens} | ${estCost} | ${seconds(mean((a) => a.latencyMs))} s | ${rs.reduce((n, a) => n + a.formulaErrors, 0)} | ${unsupported || '—'} | ${requests || '—'} | ${rs.some((a) => a.explanation) ? 'yes' : '—'} |`,
      );
    }
  }
  out.push('');
  out.push('Calls, tokens and latency are the mean over the measured seeds. "Est." is our own count of the text sent and received, priced with the providers\' published prices (`packages/shared/src/config/pricing.ts`): the numbers to compare runs by, since the dev CLI\'s own tokens include Claude Code\'s overhead and thinking tokens. A model with no price shows n/a.');
  out.push('');

  out.push('### Functions the AI asked for');
  out.push('');
  if (ai.functionRequests.length === 0) out.push('None: no answer carried a function request.');
  else {
    out.push('The names only (a request is value-free; its purpose and arguments are not recorded here). These are what the AI thinks the language lacks, for the types it could not finish.');
    out.push('');
    out.push('| Function | Types |');
    out.push('|---|---|');
    for (const f of ai.functionRequests) out.push(`| \`${f.name}\` | ${f.types.map((x) => `\`${x}\``).join(', ')} |`);
  }
  out.push('');
  return out;
}

export function renderMarkdown(s: Summary): string {
  const t = s.totals;
  const seeds = [...new Set(s.records.map((r) => r.seed))];
  const wrong = t.fastOverfit + t.fastUnverified;
  const out: string[] = [];
  out.push('# Rule catalogue: capability map');
  out.push('');
  out.push(`Generated by \`eval/catalogue/run-catalogue.ts\`: ${t.types} transformation types, seeds ${seeds.join(', ')}, ${s.ai ? 'the free layers make no AI calls (the AI layer is its own section below)' : 'no AI calls'}. Regenerate with \`pnpm --filter @formatai/eval exec tsx catalogue/run-catalogue.ts\`.`);
  out.push('');
  out.push('- **Language**: can the rules language express the type? A reference rule (formula text + rules structure) must parse, type-check and reproduce the expected output exactly.');
  out.push('- **Fast engine**: does the free code engine (pair analysis + strict fast path, AI not allowed) finish it from the example pair alone? `partial n/m columns` = those columns are built, the rest need the AI step. A type is only `✓` when the learned rules are verified on the example AND convert the "next month" file exactly (hold-out).');
  out.push("- **⚠ wrong**: the fast engine produced rules that are wrong. Either they pass the engine's own verification but not the exact hold-out comparison (`verified, wrong on next file`), or they fail the engine's own verification (`local rules fail own verification`) although the path reports `local`.");
  out.push("- **Unsolved column(s) classified as**: how pair analysis sees a column the fast path did not build: `external` (nothing in the input explains it), `derived/<hint>` (a dependency code can see: `dependsOn`, `bands`, `contains`), or a relation it found but declined to build (`split@1.00 declined (columnNotFullyExplained)` = the relation has no rule form; `ambiguousColumn`, `thinEvidence`).");
  if (s.ai) out.push("- **AI learns it**: the AI step (the real learn flow, AI allowed) on a type the free engine does not solve: `✓` verified on the example and the next month's file converts exactly; `~` verified on the example only; `✗` not verified; `not run` = needs the AI step but was not measured yet; `—` = nothing for the AI to do (the free engine solves it, or the language cannot express it).");
  out.push('');
  out.push('## Totals');
  out.push('');
  out.push('| | types |');
  out.push('|---|---|');
  out.push(`| Language can express it | ${t.languageOk} of ${t.types} |`);
  out.push(`| Language gap (not expressible) | ${t.languageGap} |`);
  if (t.languageBroken > 0) out.push(`| BROKEN reference rule (catalogue bug) | ${t.languageBroken} |`);
  out.push(`| Fast engine solves it (verified + hold-out) | ${t.fastSolved} |`);
  out.push(`| Fast engine partial (some columns) | ${t.fastPartial} |`);
  out.push(`| Fast engine nothing (blocked / no column built) | ${t.fastNone} |`);
  out.push(`| Fast engine wrong (${t.fastOverfit} verified but fail the next file, ${t.fastUnverified} fail own verification) | ${wrong} |`);
  out.push(`| Expressible, but not solved by the fast engine (needs the AI step) | ${s.topics.reduce((n, x) => n + x.needsAi, 0)} |`);
  out.push('');

  out.push('## By topic');
  out.push('');
  out.push('| Topic | Types | Language ✓ | Language ✗ | Fast ✓ | Fast partial | Fast nothing | Fast ⚠ wrong | Expressible, needs AI |');
  out.push('|---|---|---|---|---|---|---|---|---|');
  for (const x of s.topics) out.push(`| ${TOPIC_TITLES[x.topic]} | ${x.types} | ${x.languageOk} | ${x.languageGap + x.languageBroken} | ${x.fastSolved} | ${x.fastPartial} | ${x.fastNone} | ${x.fastWrong} | ${x.needsAi} |`);
  out.push('');

  if (s.ai) out.push(...renderAiSection(s, s.ai));

  out.push('## Language gaps (prioritized)');
  out.push('');
  if (s.gaps.length === 0) out.push('None: every type is expressible.');
  else {
    out.push('Types the rules language cannot express, grouped by the missing capability, most types first. "Unlocks" = how many catalogue types the capability would make expressible.');
    out.push('');
    out.push('| Priority | Missing capability | Family | Unlocks | Types | What is missing | Sketch |');
    out.push('|---|---|---|---|---|---|---|');
    s.gaps.forEach((g, i) => {
      const c = CAPABILITIES[g.capability];
      out.push(`| ${i + 1} | **${cell(c.title)}** (\`${g.capability}\`) | ${CAPABILITY_FAMILY_TITLES[c.family]} | ${g.types.length} | ${g.types.map((x) => `\`${x}\``).join(', ')} | ${cell(c.gap)} | ${cell(c.proposal)} |`);
    });
    out.push('');
    const byFamily = new Map<string, number>();
    for (const g of s.gaps) byFamily.set(CAPABILITIES[g.capability].family, (byFamily.get(CAPABILITIES[g.capability].family) ?? 0) + g.types.length);
    out.push(`By family: ${[...byFamily].map(([f, n]) => `${CAPABILITY_FAMILY_TITLES[f as keyof typeof CAPABILITY_FAMILY_TITLES]} ${n}`).join(', ')}.`);
  }
  out.push('');

  out.push('## Detection gaps: expressible, but the fast engine does not finish it');
  out.push('');
  if (s.detectionGaps.length === 0) out.push('None.');
  else {
    out.push('Why the fast engine did not finish a type the language CAN express, grouped by reason (a type can appear under several reasons). These are the types the AI step has to solve, and where a smarter free engine would pay.');
    out.push('');
    out.push('| Reason | Types | Which |');
    out.push('|---|---|---|');
    for (const g of s.detectionGaps) out.push(`| ${cell(g.reason)} | ${g.types.length} | ${g.types.map((x) => `\`${x}\``).join(', ')} |`);
  }
  out.push('');

  out.push('## How pair analysis classifies the columns the fast path leaves');
  out.push('');
  if (s.columnClasses.length === 0) out.push('None.');
  else {
    out.push("Every output column not built by the fast path (first seed of each type, expressible or not), by the analysis's own classification.");
    out.push('');
    out.push('| Classification | Columns | Types |');
    out.push('|---|---|---|');
    for (const c of s.columnClasses) out.push(`| ${cell(c.cls)} | ${c.columns} | ${c.types.map((x) => `\`${x}\``).join(', ')} |`);
  }
  out.push('');

  if (s.surprises.length > 0) {
    out.push('## Things to look at');
    out.push('');
    for (const x of s.surprises) out.push(`- ${cell(x)}`);
    out.push('');
  }

  out.push('## Capability map');
  out.push('');
  const hasAi = s.ai !== undefined;
  out.push(`| Topic | Type | Data | Language | Fast engine | Unsolved column(s) classified as | Hold-out |${hasAi ? ' AI learns it |' : ''}`);
  out.push(`|---|---|---|---|---|---|---|${hasAi ? '---|' : ''}`);
  for (const topic of TOPICS) {
    for (const x of s.types.filter((y) => y.topic === topic)) {
      out.push(`| ${TOPIC_TITLES[topic]} | \`${x.type}\` ${cell(x.title)} | ${x.lang === 'he' ? 'עב' : 'en'} | ${cell(languageCell(x))} | ${cell(fastCell(x))} | ${cell(unsolvedCell(x))} | ${holdOutCell(x)} |${hasAi ? ` ${cell(aiCell(x))} |` : ''}`);
    }
  }
  out.push('');

  out.push('## What the fast engine built (types it solved)');
  out.push('');
  const learned = new Map<string, string>();
  for (const r of s.records) if (r.fast.status === 'solved' && !learned.has(r.type)) learned.set(r.type, r.fast.how ?? '');
  if (learned.size === 0) out.push('Nothing was solved.');
  else {
    out.push('| Type | Built (computed columns, filters, structure) |');
    out.push('|---|---|');
    for (const [type, how] of learned) out.push(`| \`${type}\` | ${cell(how || '(plain column copies: types, padding and formats come from the declared input columns)')} |`);
  }
  out.push('');

  out.push('## Language gaps in detail');
  out.push('');
  for (const x of s.types.filter((y) => y.language === 'gap')) out.push(`- \`${x.type}\` (${x.capability}): ${cell(x.languageDetail)}${x.workaround ? ` Workaround for a restricted form: ${cell(x.workaround)}` : ''}`);
  out.push('');
  return out.join('\n');
}

// ---------- CSV ----------

const CSV_COLUMNS = [
  'type', 'topic', 'title', 'lang', 'seed', 'rowsIn', 'rowsOut',
  'language_expressible', 'language_capability', 'language_valid', 'language_reproduces', 'language_mismatch',
  'fast_path', 'fast_status', 'fast_verified', 'fast_viaPartial', 'fast_solved', 'fast_total', 'fast_unsolved', 'fast_blockedBy', 'fast_reason', 'fast_needsAiParts', 'fast_holdOut', 'fast_how', 'fast_ms',
  'ai_model', 'ai_path', 'ai_verified', 'ai_holdOut', 'ai_llmCalls', 'ai_tokensIn', 'ai_tokensOut', 'ai_costUsd', 'ai_latencyMs',
] as const;

/** Appended only when some record has an AI result (a free-run CSV stays exactly what it was). */
const CSV_AI_COLUMNS = [
  'ai_provider', 'ai_mode', 'ai_masking', 'ai_noEscalation', 'ai_status', 'ai_classification', 'ai_tokensCached', 'ai_estInTokens', 'ai_estCachedTokens', 'ai_estCacheWriteTokens', 'ai_estOutTokens', 'ai_estCostUsd', 'ai_formulaErrors', 'ai_callErrors',
  'ai_unsupported', 'ai_functionRequests', 'ai_explanation', 'ai_error', 'ai_at',
] as const;

function csvField(v: unknown): string {
  if (v === undefined || v === null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function renderCsv(records: CatalogueRecord[]): string {
  const columns: readonly string[] = records.some((r) => r.ai) ? [...CSV_COLUMNS, ...CSV_AI_COLUMNS] : CSV_COLUMNS;
  const lines = [columns.join(',')];
  for (const r of records) {
    const f = r.fast;
    const l = r.language;
    const a = r.ai;
    const row: Record<string, unknown> = {
      type: r.type, topic: r.topic, title: r.title, lang: r.lang, seed: r.seed, rowsIn: r.rowsIn, rowsOut: r.rowsOut,
      language_expressible: l.expressible, language_capability: l.capability, language_valid: l.valid, language_reproduces: l.reproduces, language_mismatch: l.mismatch,
      fast_path: f.path, fast_status: f.status, fast_verified: f.verified, fast_viaPartial: f.viaPartial, fast_solved: f.solvedColumns.length, fast_total: f.totalColumns,
      fast_unsolved: f.unsolved.map((u) => `${u.header}:${u.cls}${u.hint ? `/${u.hint}` : ''}`).join(';'), fast_blockedBy: f.blockedBy.join(';'), fast_reason: f.fastReason,
      fast_needsAiParts: f.needsAiParts.join(';'), fast_holdOut: f.holdOut, fast_how: f.how, fast_ms: f.ms,
      ai_model: a?.model, ai_path: a?.path, ai_verified: a?.verified, ai_holdOut: a?.holdOut, ai_llmCalls: a?.llmCalls, ai_tokensIn: a?.tokensIn, ai_tokensOut: a?.tokensOut, ai_costUsd: a?.costUsd, ai_latencyMs: a?.latencyMs,
      ai_provider: a?.provider, ai_mode: a?.mode, ai_masking: a?.masking, ai_noEscalation: a?.noEscalation, ai_status: a ? aiStatusOf(a) : undefined, ai_classification: a?.classification,
      ai_tokensCached: a?.tokensCached, ai_estInTokens: a?.estimate?.inputTokens, ai_estCachedTokens: a?.estimate?.cachedInputTokens, ai_estCacheWriteTokens: a?.estimate?.cacheWriteTokens, ai_estOutTokens: a?.estimate?.outputTokens, ai_estCostUsd: a?.estimate?.costUsd, ai_formulaErrors: a?.formulaErrors, ai_callErrors: a?.callErrors, ai_unsupported: a?.unsupported.join(';'),
      ai_functionRequests: a?.functionRequests.join(';'), ai_explanation: a?.explanation, ai_error: a?.error, ai_at: a?.at,
    };
    lines.push(columns.map((c) => csvField(row[c])).join(','));
  }
  return `${lines.join('\n')}\n`;
}
