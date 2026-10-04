// learn-v8 (owner decision 2026-10-04; SPEC 9.2, 21 v12 item 17): an answer may give a second rule for an output column (`alternatives`).
// The API takes them off before the answer is checked, so the answer is checked exactly as before; each alternative passes the same
// layers on its own (formula, structure, references, types, limits) with only its column swapped in. An invalid one is dropped and counted
// in the call record's `problemCounts.invalidAlternative` - never repaired, never a reason to repair the answer.
import { describe, expect, it } from 'vitest';
import { learnResultWireJsonSchema, limits, LEARN_SYSTEM_PROMPT_V7, type LearnPayload } from '@formatai/shared';
import { loadEnv } from '../../src/env.js';
import { createFakeProvider, type CompleteRequest, type FakeLlmProvider } from '../../src/llm/index.js';
import { countProblems, learn, repairFromBrowser, runChecks, type CompleteFn } from '../../src/learn/index.js';
import { basicPayload, correctRules, correctRulesWireJson, schemaBrokenRulesJson } from './fixtures.js';

const env = loadEnv({ ...process.env, LLM_PROVIDER: 'fake' });
const fakeCompleteFn = (fake: FakeLlmProvider): CompleteFn => (req: CompleteRequest) => fake.complete(req);

/** `basicPayload` (ID copied, Total = Amount x 2) with a third column, Note = ID. */
function payload(): LearnPayload {
  const p = basicPayload();
  return {
    ...p,
    output: { ...p.output, columns: [...p.output.columns, { i: 2, header: 'Note', type: 'text' }] },
    samples: p.samples.map((s) => ({ in: s.in, out: [...(s.out as (string | number)[]), s.in[0]!] })),
  };
}

/** The correct answer for `payload()`, in wire form, with `alternatives` added. */
function answer(alternatives?: unknown[]): Record<string, unknown> {
  const wire = correctRulesWireJson() as { output: { columns: unknown[] } } & Record<string, unknown>;
  const withNote = { ...wire, output: { ...wire.output, columns: [...wire.output.columns, { header: 'Note', from: 'id' }] } };
  return alternatives === undefined ? withNote : { ...withNote, alternatives };
}

const plus = { outputColumn: 'Total', from: 'totalAlt', computed: [{ id: 'totalAlt', type: 'decimal', expr: 'amount + amount' }] };

describe('runChecks: alternatives', () => {
  it('an answer without alternatives is checked as before; one with them is checked the same, and the valid ones come back as trees', () => {
    const plain = runChecks(answer(), payload(), { tier: 'registered' });
    expect(plain.problems).toEqual([]);
    expect(plain.alternatives).toEqual([]);
    expect(plain.invalidAlternatives).toBe(0);

    const checked = runChecks(answer([plus]), payload(), { tier: 'registered' });
    expect(checked.problems).toEqual([]);
    expect(checked.rules).toEqual(plain.rules);
    expect(checked.alternatives).toEqual([
      { outputColumn: 'Total', from: 'totalAlt', computed: [{ id: 'totalAlt', type: 'decimal', expr: { op: 'add', args: [{ col: 'amount' }, { col: 'amount' }] } }] },
    ]);
    expect(checked.invalidAlternatives).toBe(0);
  });

  it('a plain copy is an alternative too (a `from` of the answer, no computed column)', () => {
    const checked = runChecks(answer([{ outputColumn: 'Note', from: 'amount', computed: [] }]), payload(), { tier: 'registered' });
    // Note is text and Amount a number: the type does not fit the column - dropped. A copy of ID for Total does not fit either.
    expect(checked.alternatives).toEqual([]);
    expect(checked.invalidAlternatives).toBe(1);
    const copy = runChecks(answer([{ outputColumn: 'Note', from: 'noteAlt', computed: [{ id: 'noteAlt', type: 'text', expr: 'concat(id, "")' }] }]), payload(), { tier: 'registered' });
    expect(copy.alternatives).toHaveLength(1);
  });

  it('drops (and counts) an invalid alternative, and never adds a problem to the answer or a repair', () => {
    const invalid = [
      { outputColumn: 'Total', from: 'x', computed: [{ id: 'x', type: 'decimal', expr: 'amount *' }] }, // formula text
      { outputColumn: 'Total', from: 'x', computed: [{ id: 'x', type: 'decimal', expr: 'nope * 2' }] }, // reference
      { outputColumn: 'Total', from: 'total', computed: [{ id: 'total', type: 'decimal', expr: 'amount * 3' }] }, // id clashes with the answer's
      { outputColumn: 'Total', from: 'x', computed: [{ id: 'x', type: 'text', expr: 'concat(id, "!")' }] }, // type does not fit Total
      { outputColumn: 'Total', from: 'x', computed: [{ id: 'x', type: 'decimal', expr: 'amount * 2' }] }, // the answer's own rule again
      { outputColumn: 'Nope', from: 'amount', computed: [] }, // no such column
      { outputColumn: 'Total', computed: [] }, // shape
      'Total = amount * 3', // shape
    ];
    for (const alt of invalid) {
      const checked = runChecks(answer([alt]), payload(), { tier: 'registered' });
      expect(checked.problems, JSON.stringify(alt)).toEqual([]);
      expect(checked.alternatives, JSON.stringify(alt)).toEqual([]);
      expect(checked.invalidAlternatives, JSON.stringify(alt)).toBe(1);
    }
  });

  it('at most one per column and at most limits.learn.maxAlternatives per answer: the rest are dropped', () => {
    const second = { outputColumn: 'Total', from: 'y', computed: [{ id: 'y', type: 'decimal', expr: 'amount * 4 - amount * 2' }] };
    const one = runChecks(answer([plus, second]), payload(), { tier: 'registered' });
    expect(one.alternatives.map((a) => a.from)).toEqual(['totalAlt']);
    expect(one.invalidAlternatives).toBe(1);

    expect(limits.learn.maxAlternatives).toBe(3);
    const many = Array.from({ length: 5 }, (_, i) => ({ outputColumn: i % 2 === 0 ? 'Total' : 'Note', from: `a${i}`, computed: [{ id: `a${i}`, type: i % 2 === 0 ? 'decimal' : 'text', expr: i % 2 === 0 ? `amount + amount + ${i} - ${i}` : `concat(id, "${i}")` }] }));
    const capped = runChecks(answer(many), payload(), { tier: 'registered' });
    expect(capped.alternatives.map((a) => a.outputColumn)).toEqual(['Total', 'Note']);
    expect(capped.invalidAlternatives).toBe(3);
  });

  it('an answer that does not parse has nothing to swap them into: none checked, none counted; learn-v7 drops (and counts) them all', () => {
    const broken = { ...(schemaBrokenRulesJson() as object), alternatives: [plus] };
    expect(runChecks(broken, basicPayload(), { tier: 'registered' })).toMatchObject({ rules: null, alternatives: [], invalidAlternatives: 0 });
    expect(runChecks(answer([plus]), payload(), { tier: 'registered', alternatives: false })).toMatchObject({ problems: [], alternatives: [], invalidAlternatives: 1 });
  });

  it('completion mode: only a column the AI step was asked for may have one', () => {
    const p: LearnPayload = { ...payload(), complete: { fixed: { ...answer(), output: { ...(answer().output as object), columns: [{ header: 'ID', from: 'id' }, { header: 'Total', from: null }, { header: 'Note', from: 'id' }] } } as never, columns: [1], parts: [] } };
    const forNote = runChecks(answer([{ outputColumn: 'Note', from: 'n', computed: [{ id: 'n', type: 'text', expr: 'concat(id, "")' }] }]), p, { tier: 'registered' });
    expect(forNote.alternatives).toEqual([]);
    expect(forNote.invalidAlternatives).toBe(1);
    const forTotal = runChecks(answer([plus]), p, { tier: 'registered' });
    expect(forTotal.alternatives).toHaveLength(1);
  });
});

describe('learn(): the alternatives of the kept answer, and the count on the call record', () => {
  it('returns the checked alternatives beside the rules and counts the dropped ones in problemCounts.invalidAlternative', async () => {
    const fake = createFakeProvider();
    fake.enqueue({ json: answer([plus, { outputColumn: 'Nope', from: 'amount', computed: [] }]) });
    const outcome = await learn(payload(), { tier: 'registered', env, complete: fakeCompleteFn(fake) });
    expect(outcome.verified).toBe(true);
    expect(outcome.rules).not.toHaveProperty('alternatives');
    expect(outcome.alternatives?.map((a) => a.from)).toEqual(['totalAlt']);
    expect(outcome.calls[0]!.problemCounts).toMatchObject({ invalidAlternative: 1, formula: 0 });
    expect(outcome.calls[0]!.outcome).toBe('verified');
    expect(countProblems([])).toMatchObject({ invalidAlternative: 0 });
  });

  it('an invalid alternative never causes a repair: one call, the answer verified', async () => {
    const fake = createFakeProvider();
    fake.enqueue({ json: answer([{ outputColumn: 'Total', from: 'x', computed: [{ id: 'x', type: 'decimal', expr: 'amount *' }] }]) });
    const outcome = await learn(payload(), { tier: 'registered', env, complete: fakeCompleteFn(fake) });
    expect(fake.calls).toHaveLength(1);
    expect(outcome.verified).toBe(true);
    expect(outcome.alternatives).toBeUndefined();
  });

  it('a browser round returns the alternatives of its answer too', async () => {
    const fake = createFakeProvider();
    fake.enqueue({ json: answer([plus]) });
    const outcome = await repairFromBrowser(payload(), correctRules(), [], { tier: 'registered', env, complete: fakeCompleteFn(fake) });
    expect(outcome.alternatives).toHaveLength(1);
  });

  it('--prompt learn-v7 sends the learn-v7 prompt and the schema without alternatives, and records that version', async () => {
    const fake = createFakeProvider();
    fake.enqueue({ json: answer([plus]) });
    const outcome = await learn(payload(), { tier: 'registered', env, complete: fakeCompleteFn(fake), prompt: 'learn-v7' });
    const sent = fake.calls[0]!;
    expect(sent.system).toBe(LEARN_SYSTEM_PROMPT_V7);
    expect(sent.schema).toEqual(learnResultWireJsonSchema({ alternatives: false }));
    expect(outcome.calls[0]).toMatchObject({ promptVersion: 'learn-v7', problemCounts: { invalidAlternative: 1 } });
    expect(outcome.alternatives).toBeUndefined();
    // The default is the current version, with the schema that offers them.
    const fake8 = createFakeProvider();
    fake8.enqueue({ json: answer() });
    const current = await learn(payload(), { tier: 'registered', env, complete: fakeCompleteFn(fake8) });
    expect(fake8.calls[0]!.schema).toEqual(learnResultWireJsonSchema());
    expect(current.calls[0]!.promptVersion).toBe('learn-v8');
  });
});
