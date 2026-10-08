// Measures one (type, seed): the LANGUAGE layer (does the reference rule parse, type-check and reproduce the expected output?)
// and the FAST layer (does the free code engine - pair analysis + strict fast path, no AI - detect the transformation from the
// example pair, and does what it learned convert a "next month" file exactly?). Returns one `CatalogueRecord`.
//
// The AI layer is a later phase: it calls the same `prepare` (so it sees the very same files), runs its own learn, and fills
// `record.ai` - nothing in this file or in the record's other fields changes.
import fs from 'node:fs';
import path from 'node:path';
import {
  chooseColumnRelation,
  fastPath,
  verifyAgainstExample,
  learnFromExamples,
  printFormula,
  type LearnFromExamplesResult,
  type PairAnalysis,
} from '@formatai/engine';
import type { LearnResult, Rules } from '@formatai/shared';
import { checkHoldOut } from '../lib/holdout';
import { convertWith, expectedTable, firstDifference, generateRows, inputFile, outputFile, parseRules, type FileArtifact } from './kit';
import type { CatalogueRecord, CatalogueType, FastRecord, FastStatus, LanguageRecord, UnsolvedColumn } from './types';

/** The files of one (type, seed): the example pair a user would give, and the hold-out ("next month") pair. */
export interface Prepared {
  type: CatalogueType;
  seed: number;
  rowsIn: number;
  rowsOut: number;
  input: FileArtifact;
  output: FileArtifact;
  nextInput: FileArtifact;
  nextOutput: FileArtifact;
}

export async function prepare(type: CatalogueType, seed: number): Promise<Prepared> {
  const rows = generateRows(type, seed, 'example');
  const nextRows = generateRows(type, seed, 'next');
  const table = expectedTable(type, rows);
  const nextTable = expectedTable(type, nextRows);
  return {
    type,
    seed,
    rowsIn: rows.length,
    rowsOut: table.rows.length,
    input: await inputFile(type, rows),
    output: await outputFile(type, table, rows),
    nextInput: await inputFile(type, nextRows),
    nextOutput: await outputFile(type, nextTable, nextRows),
  };
}

// ---------- Language layer ----------

const parsedCache = new Map<string, ReturnType<typeof parseRules>>();

export async function measureLanguage(p: Prepared): Promise<{ record: LanguageRecord; rules?: Rules }> {
  const { type } = p;
  if (type.rule === null) {
    if (!type.missing) throw new Error(`${type.id}: rule is null but \`missing\` is not set`);
    return { record: { expressible: false, capability: type.missing.capability, missingDetail: type.missing.detail, ...(type.missing.workaround !== undefined ? { workaround: type.missing.workaround } : {}) } };
  }
  let parsed = parsedCache.get(type.id);
  if (!parsed) {
    parsed = parseRules(type);
    parsedCache.set(type.id, parsed);
  }
  if (!parsed.ok || !parsed.rules) return { record: { expressible: true, valid: false, problems: parsed.problems, reproduces: false, mismatch: 'reference rule is invalid' } };

  const record: LanguageRecord = { expressible: true, valid: true, problems: [], reproduces: true };
  for (const [label, input, expected] of [
    ['example', p.input, p.output],
    ['next', p.nextInput, p.nextOutput],
  ] as const) {
    const ran = await convertWith(parsed.rules, input);
    if (!ran.ok) {
      record.reproduces = false;
      record.mismatch = `${label}: convertFile failed ${ran.error}`;
      break;
    }
    const diff = await firstDifference({ name: expected.name, bytes: ran.bytes }, expected);
    if (diff !== null) {
      record.reproduces = false;
      record.mismatch = `${label}: ${diff}`;
      break;
    }
  }
  return { record, rules: parsed.rules };
}

// ---------- Fast layer ----------

function relationLabel(r: { rel: string; coverage: number }): string {
  return `${r.rel}@${r.coverage.toFixed(2)}`;
}

/** What the analysis knows about an output column the fast path did not build. */
function describeUnsolved(analysis: PairAnalysis, out: number, rowsBuilt: boolean): UnsolvedColumn {
  const ca = analysis.columns[out];
  const header = ca?.header ?? `column${out + 1}`;
  if (!ca) return { out, header, cls: 'external', hint: '', reason: 'noAnalysis', relations: [] };
  const relations = ca.relations.map(relationLabel);
  // An across-row pattern the free engine found but does not write (a running total, a rank, a row number ...): the AI step gets it, with the hint.
  const window = ca.windows?.[0];
  if (window !== undefined && !ca.relations.some((r) => r.rel === 'window')) {
    return { out, header, cls: 'derived', hint: `window:${window.fn}`, reason: 'columnNotFullyExplained', relations: [...relations, ...(ca.windows ?? []).map((w) => `window:${w.fn}@${w.coverage.toFixed(2)}`)] };
  }
  if (ca.relations.length > 0) {
    const chosen = chooseColumnRelation(analysis, ca);
    const reason = 'reason' in chosen ? chosen.reason : rowsBuilt ? 'notBuilt' : 'rowsNotBuilt';
    return { out, header, cls: 'related', hint: ca.relations[0]!.rel, reason, relations };
  }
  if (ca.derived) {
    const d = ca.derived;
    const hint = d.kind === 'bands' ? 'bands' : d.kind === 'composition' ? 'contains' : 'dependsOn';
    return { out, header, cls: 'derived', hint, reason: 'columnNotFullyExplained', relations };
  }
  return { out, header, cls: 'external', hint: '', reason: 'columnNotFullyExplained', relations };
}

/** A short text of what the learned (local) rules do: computed columns as formulas, plus the row-level parts. */
function describeRules(rules: LearnResult): string {
  const parts: string[] = [];
  const computedIds = new Set(rules.transform.computed.map((c) => c.id));
  for (const col of rules.output.columns) {
    const c = rules.transform.computed.find((x) => x.id === col.from);
    if (c) parts.push(`${col.header} = ${printFormula(c.expr)}`);
    else if (col.from !== null && !computedIds.has(col.from)) {
      const vm = rules.transform.valueMaps.find((m) => m.column === col.from);
      if (vm) parts.push(`${col.header} = map(${col.from}, ${Object.keys(vm.map).length} values)`);
    }
  }
  for (const f of rules.input.rowFilters ?? []) parts.push(`keep rows where ${'expr' in f ? printFormula(f.expr) : `${f.column} ${f.op}${'value' in f ? ` ${JSON.stringify(f.value)}` : ''}`}`);
  if (rules.transform.dedupe) parts.push(`dedupe(${rules.transform.dedupe.keys === 'all' ? 'all columns' : 'key'}, keep ${rules.transform.dedupe.keep})`);
  if (rules.transform.expand) parts.push(`expand: ${rules.transform.expand.mode}`);
  if (rules.transform.sort.length > 0) parts.push('sort');
  if (rules.transform.group) parts.push('group');
  if (rules.output.titleRows.length > 0) parts.push(`titleRows: ${rules.output.titleRows.length}`);
  const text = parts.join('; ');
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

function statusOf(path: FastRecord['path'], verified: boolean | null, holdOut: FastRecord['holdOut'], solved: number): FastStatus {
  if (path === 'local') {
    if (verified !== true) return 'unverified';
    return holdOut === 'fail' ? 'overfit' : 'solved';
  }
  if (path === 'partial') return solved > 0 ? 'partial' : 'none';
  return 'none';
}

export async function measureFast(p: Prepared): Promise<{ record: FastRecord; learned: LearnResult | null }> {
  const t0 = Date.now();
  let analysis: PairAnalysis | undefined;
  let res: LearnFromExamplesResult;
  try {
    res = await learnFromExamples({
      input: { bytes: p.input.bytes, name: p.input.name },
      output: { bytes: p.output.bytes, name: p.output.name },
      masking: false,
      tier: 'paid',
      ai: 'notAllowed',
      callLearn: async () => {
        throw new Error('the catalogue fast layer never calls the AI step');
      },
      onAnalysis: (a) => {
        analysis = a;
      },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      record: { path: 'error', status: 'none', verified: null, solvedColumns: [], totalColumns: p.type.outputs.length, unsolved: [], blockedBy: [], needsAiParts: [], holdOut: 'n/a', error: message, ms: Date.now() - t0 },
      learned: null,
    };
  }

  const totalColumns = analysis?.output.columnCount ?? p.type.outputs.length;
  const record: FastRecord = {
    // (no `known` is given here, so 'known' - "you already have this format" - never comes back)
    path: res.path === 'llm' || res.path === 'known' ? 'error' : res.path,
    status: 'none',
    verified: res.verification ? res.verification.verified : null,
    solvedColumns: [],
    totalColumns,
    unsolved: [],
    blockedBy: [],
    needsAiParts: [],
    holdOut: 'n/a',
    ms: 0,
  };

  const rowsBuilt = analysis ? analysis.shape.kind === 'plain' || res.path === 'local' : false;
  const headerOf = (i: number): string => analysis?.columns[i]?.header || `column${i + 1}`;

  if (res.path === 'local') {
    record.solvedColumns = Array.from({ length: totalColumns }, (_, i) => headerOf(i));
    if (res.rules) record.how = describeRules(res.rules);
  } else if (res.path === 'partial' && res.partial) {
    record.solvedColumns = res.partial.solved;
    record.needsAiParts = res.partial.needsAiParts;
    const solvedIdx = new Set(res.partial.solvedColumns);
    if (analysis) {
      for (let i = 0; i < totalColumns; i++) if (!solvedIdx.has(i)) record.unsolved.push(describeUnsolved(analysis, i, rowsBuilt));
    }
    if (res.rules) record.how = describeRules(res.rules);
  } else {
    record.blockedBy = res.preflight.issues.filter((i) => i.severity !== 'info').map((i) => i.code);
    if (res.path === 'notReady' && res.readiness && !res.readiness.ready) record.blockedBy.push(...res.readiness.issues.map((i) => i.code));
    if (analysis) for (let i = 0; i < totalColumns; i++) record.unsolved.push(describeUnsolved(analysis, i, false));
  }

  // Why the strict path declined, in one code (even when the partial result builds some of it).
  if (analysis && res.path !== 'local') {
    const fp = fastPath(analysis, res.preflight);
    if ('reason' in fp) record.fastReason = fp.params ? `${fp.reason} ${JSON.stringify(fp.params)}` : fp.reason;
  }

  // A partial result with nothing left for the AI step (the partial builder made the expand itself) is a complete rules file: judge it like a local one.
  const complete = res.path === 'partial' && res.rules !== null && analysis !== undefined && record.unsolved.length === 0 && record.needsAiParts.length === 0;
  if (complete && res.rules && analysis) {
    record.viaPartial = true;
    record.verified = verifyAgainstExample(res.rules, analysis).verified;
  }

  // Hold-out: only a finished conversion is worth testing on next month's file.
  if ((res.path === 'local' || (complete && record.verified === true)) && res.rules) {
    const ho = await checkHoldOut(res.rules, {
      input: { fileName: p.nextInput.name, bytes: p.nextInput.bytes },
      output: { fileName: p.nextOutput.name, bytes: p.nextOutput.bytes },
    });
    record.holdOut = ho.ok ? 'pass' : 'fail';
    if (!ho.ok) record.holdOutDetail = ho.reason ?? 'next output differs';
  }

  record.status = statusOf(record.viaPartial === true ? 'local' : record.path, record.verified, record.holdOut, record.solvedColumns.length);
  record.ms = Date.now() - t0;
  return { record, learned: res.rules };
}

// ---------- One (type, seed) ----------

export interface MeasureOptions {
  /** Write the generated files and the rules (reference and learned) of every (type, seed) under this directory. */
  dumpDir?: string;
}

export async function measure(type: CatalogueType, seed: number, opts: MeasureOptions = {}): Promise<CatalogueRecord> {
  const p = await prepare(type, seed);
  const lang = await measureLanguage(p);
  const fast = await measureFast(p);
  if (opts.dumpDir) {
    const dir = path.join(opts.dumpDir, type.id, `seed${seed}`);
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, f] of [['input', p.input], ['output', p.output], ['next.input', p.nextInput], ['next.output', p.nextOutput]] as const) {
      fs.writeFileSync(path.join(dir, `${name}${path.extname(f.name)}`), Buffer.from(f.bytes));
    }
    if (lang.rules) fs.writeFileSync(path.join(dir, 'reference.rules.json'), `${JSON.stringify(lang.rules, null, 2)}\n`);
    if (fast.learned) fs.writeFileSync(path.join(dir, 'learned.rules.json'), `${JSON.stringify(fast.learned, null, 2)}\n`);
  }
  return {
    type: type.id,
    topic: type.topic,
    title: type.title,
    lang: type.lang,
    seed,
    rowsIn: p.rowsIn,
    rowsOut: p.rowsOut,
    language: lang.record,
    fast: fast.record,
  };
}
