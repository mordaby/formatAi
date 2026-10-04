// Privacy (SPEC 7.2, 9.3, 15): with masking on, the browser's repair request - the payload and the problems it carries -
// holds no real value of the example. Every value it quotes is masked the way the samples are (numbers, dates, headers and label words are
// sent real by design); one that cannot be masked is left out. Walked over the eval cases whose output has title and summary rows, with an
// answer that gets the titles, the summary labels and a text column wrong, so the repair carries layout problems that quote cells and diff
// problems with rows. No LLM: the answer is canned.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyzePair, learnFromExamples, normalizeText, readWorkbook, sniffDelimitedText, splitWords, type LearnCallResult, type PairAnalysis } from '@formatai/engine';
import type { LearnPayload, LearnResult, RepairProblem, Rules } from '@formatai/shared';
import { loadCase, type CaseDef } from '../lib/caseLoader';

const CASES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cases');
/** The eval cases with title rows, summary rows or group summary rows in their output. */
const WITH_TITLES_OR_SUMMARIES = ['stock-count-warehouse-report', 'purchase-orders-supplier-summary', 'insurer-commission-control'];

async function analysisOf(c: CaseDef): Promise<PairAnalysis> {
  const input = await readWorkbook(c.input.bytes, c.input.fileName);
  const output = await readWorkbook(c.output.bytes, c.output.fileName);
  const sniff = output.fileType === 'csv' || output.fileType === 'txt' ? sniffDelimitedText(c.output.bytes) : undefined;
  const a = analyzePair(input, output, sniff ? { outputSniff: sniff } : {});
  if (!a.ok) throw new Error(`${c.name}: the analysis failed`);
  return a;
}

const wordsOf = (text: string): string[] => splitWords(text).flatMap((t) => (t.isWord ? [normalizeText(t.text)] : []));

/**
 * The words masking must hide: every word of a text or ID-like data cell of the example, input or output - with letters in it and 4
 * characters or more, or all digits and 6 or more (so a fake word, or a number sent real, can't match one by chance) - less the words sent
 * real by design: the headers and sheet names.
 */
function realWords(a: PairAnalysis): Set<string> {
  const words = new Set<string>();
  const add = (row: readonly ({ v: unknown } | null)[] | undefined, profile: readonly { type: string }[]): void => {
    profile.forEach((p, c) => {
      const v = row?.[c]?.v;
      if (typeof v !== 'string' || (p.type !== 'text' && p.type !== 'idLike')) return;
      for (const w of wordsOf(v)) if ((w.length >= 4 && /\p{L}/u.test(w)) || (w.length >= 6 && /^\d+$/.test(w))) words.add(w);
    });
  };
  for (const row of a.input.rows) add(row, a.input.profile);
  for (const r of a.output.dataRows) add(a.output.sheet.rows[r], a.output.profile);
  for (const sent of [...a.input.headers, ...a.output.headers, a.input.sheetName, a.layout.sheetName]) for (const w of wordsOf(sent ?? '')) words.delete(w);
  return words;
}

/**
 * The reference answer, wrong where the repair must quote the example: every title and summary label, one text column (cell diffs), and each
 * summary row showing the first value of a text column - so the rows the rules make carry real text values of the example, which the
 * layout problems quote.
 */
function wrongAnswer(rules: Rules): LearnResult {
  const { name: _name, meta: _meta, ...r } = JSON.parse(JSON.stringify(rules)) as Rules;
  const text = r.input.columns.filter((c) => c.type === 'text' || c.type === 'idLike');
  // (text columns first: their values are words; ID-like ones after)
  const typeOf = (from: string | null): string | undefined => text.find((c) => c.id === from)?.type;
  const textOut = r.output.columns.filter((o) => typeOf(o.from) !== undefined).sort((x, y) => Number(typeOf(x.from) !== 'text') - Number(typeOf(y.from) !== 'text')).map((o) => o.header);
  const withFirst = <S extends { label?: string; labelColumn?: string; cells: Record<string, string> }>(s: S, label: string): S => {
    const header = textOut.find((h) => h !== s.labelColumn && s.cells[h] === undefined);
    return { ...s, ...(s.label !== undefined ? { label } : {}), cells: { ...s.cells, ...(header ? { [header]: 'first' } : {}) } };
  };
  r.output.titleRows = r.output.titleRows.map((t) => ('text' in t ? { ...t, text: 'Wrong title' } : 'parts' in t ? { ...t, parts: t.parts.map((p) => ('text' in p ? { text: 'Wrong ' } : p)) } : t));
  r.output.summaryRows = (r.output.summaryRows ?? []).map((s) => withFirst(s, 'Wrong total'));
  if (r.transform.group?.summaryRows) r.transform.group.summaryRows = r.transform.group.summaryRows.map((s) => withFirst(s, 'Wrong subtotal'));
  const target = r.output.columns.find((o) => text.some((c) => c.id === o.from));
  const other = text.find((c) => c.id !== target?.from);
  if (target && other) target.from = other.id;
  return r as unknown as LearnResult;
}

interface Captured {
  payload: LearnPayload;
  problems: RepairProblem[];
}

describe('a repair request built with masking on holds no real value of the example', () => {
  it.each(WITH_TITLES_OR_SUMMARIES)('%s: payload and problems (cells and messages)', async (name) => {
    const c = loadCase(path.join(CASES, name))!;
    const a = await analysisOf(c);
    expect(a.layout.titleRows.length + a.layout.summaryRows.length + (a.layout.groupBy?.summaryRows?.length ?? 0)).toBeGreaterThan(0);
    const real = realWords(a);
    expect(real.size).toBeGreaterThan(0);

    const repairs: Captured[] = [];
    const result = await learnFromExamples({
      input: { bytes: c.input.bytes, name: c.input.fileName },
      output: { bytes: c.output.bytes, name: c.output.fileName },
      masking: true,
      key: new TextEncoder().encode(`masked-repair:${name}`),
      tier: 'paid',
      callLearn: async (): Promise<LearnCallResult> => ({ rules: wrongAnswer(c.referenceRules!), problems: [], calls: [] }),
      callRepair: async (payload, _previous, problems): Promise<LearnCallResult> => {
        repairs.push({ payload, problems });
        return { rules: null, problems: [], calls: [] };
      },
    });
    expect(result.path).toBe('llm');
    expect(repairs).toHaveLength(1);
    const { payload, problems } = repairs[0]!;
    // the repair quotes the example: layout rows (titles, summary rows) and diffs with their rows
    expect(problems.some((p) => p.kind === 'layout' && /: expected /.test(p.message))).toBe(true);

    const sent = JSON.stringify({ payload, problems });
    const leaked = [...new Set(wordsOf(sent))].filter((w) => real.has(w));
    expect(leaked).toEqual([]);
  });
});
