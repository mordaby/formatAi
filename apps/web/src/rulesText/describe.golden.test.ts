import type { LearnResult } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { describeRules } from './describe';
import { lineTexts } from './fixtures';
import type { Line, RulesMapModel, RulesTextLang } from './types';

// Every rules file the engine and the eval harness already ship must render, in both
// languages, as clean sentences: no ids, no JSON, no holes, no direction marks.
const golden = import.meta.glob('../../../../packages/engine/test/golden/cases/*/rules.json', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;
const reference = import.meta.glob('../../../../eval/cases/*/reference.rules.json', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const cases: [string, LearnResult][] = [...Object.entries(golden), ...Object.entries(reference)].map(([path, raw]) => {
  const parts = path.split('/');
  return [`${parts.at(-3)}/${parts.at(-2)}`, JSON.parse(raw) as LearnResult];
});

/** Direction marks and embeddings/isolates: the UI isolates names itself (`<bdi>`), text carries none. */
const BIDI_CONTROLS = /[‎‏؜‪-‮⁦-⁩]/;
const BROKEN = /undefined|\[object|NaN|\bnull\b|\{|\}|"op"|"col"|"const"/;

function allLines(model: RulesMapModel): Line[] {
  return model.sections.flatMap((s) => s.lines);
}

/** Internal ids that could leak into a sentence, minus the ones that are also an ordinary name in the rules. */
function internalIds(rules: LearnResult): string[] {
  const ids = new Set<string>();
  for (const c of rules.input.columns) ids.add(c.id);
  for (const c of rules.transform.computed) ids.add(c.id);
  const e = rules.transform.expand;
  if (e?.mode === 'columnsToRows') [e.labelId, e.valueId].forEach((x) => ids.add(x));
  if (e?.mode === 'splitCell') [e.partId, e.indexId, e.countId].forEach((x) => x && ids.add(x));
  if (e?.mode === 'fixedFanOut') e.rows.forEach((r) => Object.keys(r.set).forEach((k) => ids.add(k)));

  // Words that are legitimately on screen: every header, and the names of tables, their columns and functions.
  const visible = [
    ...rules.input.columns.map((c) => c.header),
    ...rules.output.columns.map((c) => c.header),
    ...(rules.transform.tables ?? []).flatMap((t) => [t.name, ...t.columns]),
    ...(rules.transform.functions ?? []).flatMap((f) => [f.name, ...f.params.map((p) => p.name)]),
  ].map((s) => s.toLowerCase());
  return [...ids].filter((id) => /^[A-Za-z][A-Za-z0-9_]*$/.test(id) && !visible.some((v) => v.includes(id.toLowerCase())));
}

describe('the shipped rules files', () => {
  it('finds them (guards against a silently empty glob)', () => {
    expect(Object.keys(golden).length).toBeGreaterThanOrEqual(10);
    expect(Object.keys(reference).length).toBeGreaterThanOrEqual(10);
  });

  for (const lang of ['en', 'he'] as RulesTextLang[]) {
    describe(lang, () => {
      it.each(cases)('%s renders as clean sentences', (_name, rules) => {
        const model = describeRules(rules, { lang });
        const lines = allLines(model);

        // Something for every output column, in output order.
        const columnLines = model.sections.find((s) => s.id === 'columns')!.lines;
        expect(columnLines).toHaveLength(rules.output.columns.length);
        expect(columnLines.map((l) => l.target.header)).toEqual(rules.output.columns.map((c) => c.header));

        // Stable, unique ids.
        const ids = lines.map((l) => l.id);
        expect(new Set(ids).size).toBe(ids.length);

        const leaks = internalIds(rules);
        for (const line of lines) {
          expect(line.text.trim(), line.id).not.toBe('');
          expect(line.text, line.id).not.toMatch(BROKEN);
          expect(line.text, line.id).not.toMatch(BIDI_CONTROLS);
          expect(line.text, line.id).not.toMatch(/ {2}/);
          // The parts are the same sentence, piece by piece.
          expect(line.parts.map((p) => p.text).join(''), line.id).toBe(line.text);
          for (const part of line.parts) {
            expect(part.text, `${line.id} part`).not.toBe('');
            expect(part.text).not.toMatch(BIDI_CONTROLS);
            if (part.kind === 'formula') expect(part.parts.map((p) => p.text).join('')).toBe(part.text);
          }
          for (const id of leaks) expect(line.text, `${line.id} leaks "${id}"`).not.toMatch(new RegExp(`\\b${id}\\b`));
        }
        expect(model.notes).toEqual([]);
      });
    });
  }

  it('writes each language differently (not the English text in Hebrew)', () => {
    for (const [, rules] of cases) {
      const en = lineTexts(describeRules(rules, { lang: 'en' }));
      const he = lineTexts(describeRules(rules, { lang: 'he' }));
      expect(he.map(([id]) => id)).toEqual(en.map(([id]) => id)); // ids never change with the language
      expect(he.map(([, text]) => text)).not.toEqual(en.map(([, text]) => text));
    }
  });
});
