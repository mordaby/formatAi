// Turns the measurement records into the capability map (report.md) and a flat CSV. Pure functions over `CatalogueRecord[]`:
// the AI phase adds `ai` to the records and re-renders (`run-catalogue.ts --report-only`) - this file already has the column.
import { CAPABILITIES, CAPABILITY_FAMILY_TITLES, type CapabilityId } from './capabilities';
import { TOPICS, TOPIC_TITLES, type CatalogueRecord, type FastStatus, type TopicId } from './types';

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
  /** AI layer summary when the records carry it; undefined before the AI phase. */
  ai?: string;
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

function aiOf(recs: CatalogueRecord[]): string | undefined {
  const withAi = recs.filter((r) => r.ai);
  if (withAi.length === 0) return undefined;
  const ok = withAi.filter((r) => r.ai!.verified && r.ai!.holdOut !== 'fail').length;
  return `${ok}/${withAi.length}`;
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
      needsAi: ts.filter((t) => t.language === 'ok' && t.fast !== 'solved').length,
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

export function renderMarkdown(s: Summary): string {
  const t = s.totals;
  const seeds = [...new Set(s.records.map((r) => r.seed))];
  const wrong = t.fastOverfit + t.fastUnverified;
  const out: string[] = [];
  out.push('# Rule catalogue: capability map');
  out.push('');
  out.push(`Generated by \`eval/catalogue/run-catalogue.ts\`: ${t.types} transformation types, seeds ${seeds.join(', ')}, no AI calls. Regenerate with \`pnpm --filter @formatai/eval exec tsx catalogue/run-catalogue.ts\`.`);
  out.push('');
  out.push('- **Language**: can the rules language express the type? A reference rule (formula text + rules structure) must parse, type-check and reproduce the expected output exactly.');
  out.push('- **Fast engine**: does the free code engine (pair analysis + strict fast path, AI not allowed) finish it from the example pair alone? `partial n/m columns` = those columns are built, the rest need the AI step. A type is only `✓` when the learned rules are verified on the example AND convert the "next month" file exactly (hold-out).');
  out.push("- **⚠ wrong**: the fast engine produced rules that are wrong. Either they pass the engine's own verification but not the exact hold-out comparison (`verified, wrong on next file`), or they fail the engine's own verification (`local rules fail own verification`) although the path reports `local`.");
  out.push("- **Unsolved column(s) classified as**: how pair analysis sees a column the fast path did not build: `external` (nothing in the input explains it), `derived/<hint>` (a dependency code can see: `dependsOn`, `bands`, `contains`), or a relation it found but declined to build (`split@1.00 declined (columnNotFullyExplained)` = the relation has no rule form; `ambiguousColumn`, `thinEvidence`).");
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
  const hasAi = s.types.some((x) => x.ai !== undefined);
  out.push(`| Topic | Type | Data | Language | Fast engine | Unsolved column(s) classified as | Hold-out |${hasAi ? ' AI |' : ''}`);
  out.push(`|---|---|---|---|---|---|---|${hasAi ? '---|' : ''}`);
  for (const topic of TOPICS) {
    for (const x of s.types.filter((y) => y.topic === topic)) {
      out.push(`| ${TOPIC_TITLES[topic]} | \`${x.type}\` ${cell(x.title)} | ${x.lang === 'he' ? 'עב' : 'en'} | ${cell(languageCell(x))} | ${cell(fastCell(x))} | ${cell(unsolvedCell(x))} | ${holdOutCell(x)} |${hasAi ? ` ${x.ai ?? '—'} |` : ''}`);
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

function csvField(v: unknown): string {
  if (v === undefined || v === null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function renderCsv(records: CatalogueRecord[]): string {
  const lines = [CSV_COLUMNS.join(',')];
  for (const r of records) {
    const f = r.fast;
    const l = r.language;
    const a = r.ai;
    const row: Record<(typeof CSV_COLUMNS)[number], unknown> = {
      type: r.type, topic: r.topic, title: r.title, lang: r.lang, seed: r.seed, rowsIn: r.rowsIn, rowsOut: r.rowsOut,
      language_expressible: l.expressible, language_capability: l.capability, language_valid: l.valid, language_reproduces: l.reproduces, language_mismatch: l.mismatch,
      fast_path: f.path, fast_status: f.status, fast_verified: f.verified, fast_viaPartial: f.viaPartial, fast_solved: f.solvedColumns.length, fast_total: f.totalColumns,
      fast_unsolved: f.unsolved.map((u) => `${u.header}:${u.cls}${u.hint ? `/${u.hint}` : ''}`).join(';'), fast_blockedBy: f.blockedBy.join(';'), fast_reason: f.fastReason,
      fast_needsAiParts: f.needsAiParts.join(';'), fast_holdOut: f.holdOut, fast_how: f.how, fast_ms: f.ms,
      ai_model: a?.model, ai_path: a?.path, ai_verified: a?.verified, ai_holdOut: a?.holdOut, ai_llmCalls: a?.llmCalls, ai_tokensIn: a?.tokensIn, ai_tokensOut: a?.tokensOut, ai_costUsd: a?.costUsd, ai_latencyMs: a?.latencyMs,
    };
    lines.push(CSV_COLUMNS.map((c) => csvField(row[c])).join(','));
  }
  return `${lines.join('\n')}\n`;
}
