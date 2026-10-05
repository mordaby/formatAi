// The whole editor loop against the REAL engine methods (through the worker RPC, in-process): learn keeps the
// example, edits go through the store, the scheduler checks them with `liveCheck`/`fullCheck`/`staticChecks`,
// and the save status follows. Only the browser's real Worker is missing (checked by hand).
import type { Format, LearnResult } from '@formatai/shared';
import { describe, expect, it, vi } from 'vitest';
import { loopbackWorker } from '../../test/helpers/loopback';
import { engineMethods } from '../worker/engineMethods';
import { createEngineClient, type EngineClient } from '../worker/engineClient';
import type { LearnOutput } from '../worker/engineApi';
import { editorConfig } from './config';
import { LiveCheckScheduler } from './liveCheckScheduler';
import { computeSaveStatus, metaStatusOf } from './saveStatus';
import { EditorStore } from './store';
import type { EditableRules } from './types';

const enc = (s: string): ArrayBuffer => {
  const u8 = new TextEncoder().encode(s);
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
};

const SUPPLIERS = ['Acme', 'Borealis', 'Cobalt', 'Delta', 'Ember', 'Fjord'];

/** Input: Item, Supplier, Qty, Unit price. Output: Supplier, Item, Qty, Total (qty x price). */
function pair(n: number): { input: ArrayBuffer; output: ArrayBuffer } {
  const inRows = ['Item,Supplier,Qty,Unit price'];
  const outRows = ['Supplier,Item,Qty,Total'];
  for (let i = 0; i < n; i++) {
    const item = `SKU-${String(i + 1).padStart(5, '0')}`;
    const supplier = SUPPLIERS[i % SUPPLIERS.length]!;
    const qty = ((i * 7) % 40) + 1;
    const price = ((i * 13) % 900) / 10 + 1.25;
    inRows.push(`${item},${supplier},${qty},${price.toFixed(2)}`);
    outRows.push(`${supplier},${item},${qty},${(Math.round(qty * price * 100) / 100).toFixed(2)}`);
  }
  return { input: enc(inRows.join('\n') + '\n'), output: enc(outRows.join('\n') + '\n') };
}

function newEngine(): EngineClient {
  return createEngineClient({ createWorker: () => loopbackWorker(engineMethods) });
}

async function learned(engine: EngineClient, n: number): Promise<{ result: LearnOutput; rules: LearnResult; exampleId: string }> {
  const p = pair(n);
  const result = await engine.learn(
    { input: { name: 'in.csv', bytes: p.input }, output: { name: 'out.csv', bytes: p.output }, masking: false, tier: 'paid' },
    { callLearn: vi.fn(), callRepair: vi.fn(), callStep: vi.fn() },
  );
  if (!result.rules || !result.exampleId) throw new Error(`the fast path did not solve the example: ${result.path}`);
  return { result, rules: result.rules, exampleId: result.exampleId };
}

const idOfInput = (rules: EditableRules, header: string): string => rules.input.columns.find((c) => c.header === header)!.id;

/** Wait until the scheduler has a settled result for the newest revision of the store. */
async function settled(store: EditorStore, s: LiveCheckScheduler, what: 'live' | 'static' = 'live'): Promise<void> {
  await vi.waitFor(() => {
    const st = s.getState();
    const rev = store.getState().rev;
    if (what === 'live') expect(st.liveRev).toBe(rev);
    else expect(st.staticRev).toBe(rev);
    expect(st.status === 'checking').toBe(false);
  });
}

function wire(engine: EngineClient, store: EditorStore, exampleId: string | undefined, over: { format?: Format } = {}): LiveCheckScheduler {
  const s = new LiveCheckScheduler({ engine, exampleId, tier: 'paid', debounceMs: 5, ...over });
  const push = (immediate = false): void => {
    const st = store.getState();
    s.update({ rules: st.rules, exceptions: st.exceptions, rev: st.rev }, { immediate });
  };
  store.subscribe(() => push());
  push(true);
  return s;
}

const status = (store: EditorStore, s: LiveCheckScheduler, hasExample = true) => {
  const st = s.getState();
  const rev = store.getState().rev;
  return computeSaveStatus({
    rules: store.getState().rules,
    staticProblems: st.staticRev === rev ? st.staticProblems : null,
    hasExample: hasExample && st.status !== 'noExample',
    fullCheck: st.fullRev === rev ? st.full : null,
  });
}

describe('learn keeps the example in the worker', () => {
  it('returns an exampleId the live check reads; an id the worker does not hold is `exampleGone`', async () => {
    const engine = newEngine();
    const { rules, exampleId } = await learned(engine, 60);
    expect(exampleId).toMatch(/^[0-9a-f-]{36}$/);
    const check = await engine.liveCheck(exampleId, rules);
    expect(check).toMatchObject({ verified: true, matched: 60, total: 60, partial: false });
    await expect(engine.liveCheck('not-an-example', rules)).rejects.toMatchObject({ code: 'exampleGone' });
  });

  it('the newest learn replaces the example', async () => {
    const engine = newEngine();
    const first = await learned(engine, 30);
    const second = await learned(engine, 40);
    expect(second.exampleId).not.toBe(first.exampleId);
    await expect(engine.liveCheck(first.exampleId, first.rules)).rejects.toMatchObject({ code: 'exampleGone' });
    expect((await engine.liveCheck(second.exampleId, second.rules)).total).toBe(40);
  });

  it('loadExample reads the files again (for a saved conversion), and reports what it kept', async () => {
    const engine = newEngine();
    const { rules } = await learned(engine, 20);
    const p = pair(20);
    const loaded = await engine.loadExample({ input: { name: 'in.csv', bytes: p.input }, output: { name: 'out.csv', bytes: p.output } });
    if (!loaded.ok) throw new Error('loadExample failed');
    expect(loaded).toMatchObject({ inputRows: 20, outputRows: 20 });
    expect((await engine.liveCheck(loaded.exampleId, rules)).verified).toBe(true);
    // files that do not make a pair
    const bad = await engine.loadExample({ input: { name: 'a.csv', bytes: enc('x\n') }, output: { name: 'b.csv', bytes: enc('y\n') } });
    expect(bad.ok).toBe(false);
  });

  it('staticChecks runs on the worker too', async () => {
    const engine = newEngine();
    const { rules } = await learned(engine, 20);
    expect(await engine.staticChecks(rules, { tier: 'paid' })).toEqual([]);
    const bad = await engine.staticChecks({ ...rules, transform: { ...rules.transform, sort: [{ column: 'ghost', dir: 'asc' }] } }, { tier: 'paid' });
    expect(bad[0]).toMatchObject({ layer: 'references' });
  });
});

describe('editing with a live check', () => {
  it('a wrong edit shows differences, exceptions take rows out, the right edit verifies again', async () => {
    const engine = newEngine();
    const { rules, exampleId } = await learned(engine, 80);
    const store = new EditorStore(rules);
    const s = wire(engine, store, exampleId);
    await settled(store, s);
    expect(status(store, s)).toEqual({ kind: 'verified' });
    expect(metaStatusOf(status(store, s))).toBe('verified');

    // Total = qty x price x 2: every row now differs from the example.
    const total = rules.output.columns.findIndex((c) => c.header === 'Total');
    const qty = idOfInput(rules, 'Qty');
    const price = idOfInput(rules, 'Unit price');
    const bad = store.apply({ type: 'setColumnMethod', index: total, method: { kind: 'calculate', terms: [{ column: qty }, { column: price }, { number: 2 }], ops: ['*', '*'], round: 2 } });
    expect(bad.ok).toBe(true);
    await settled(store, s);
    expect(s.getState().live).toMatchObject({ matched: 0, total: 80, mismatchCount: 80, verified: false });
    expect(s.getState().live!.perColumn.find((c) => c.header === 'Total')).toMatchObject({ matched: 0, total: 80 });
    expect(s.getState().live!.preview[0]).toMatchObject({ ok: false, badColumns: [3], exampleRow: 2 });
    expect(status(store, s)).toEqual({ kind: 'differences', differences: 80 });
    expect(metaStatusOf(status(store, s))).toBe('differencesAccepted');

    // "This row was fixed by hand" for 5 rows: they leave the count.
    for (const row of [2, 3, 4, 5, 6]) store.apply({ type: 'markException', row });
    await settled(store, s);
    expect(s.getState().live).toMatchObject({ total: 75, mismatchCount: 75 });
    expect(status(store, s)).toEqual({ kind: 'differences', differences: 75 });
    expect(s.getState().live!.preview.every((p) => ![2, 3, 4, 5, 6].includes(p.exampleRow))).toBe(true);

    // undo the exceptions and the wrong edit: verified again
    for (let i = 0; i < 6; i++) store.undo();
    await settled(store, s);
    expect(s.getState().live).toMatchObject({ verified: true, matched: 80 });
    expect(status(store, s)).toEqual({ kind: 'verified' });
    expect(store.getState().dirty).toBe(false);
  });

  it('an edit the static checks refuse blocks saving, and says so in plain words', async () => {
    const engine = newEngine();
    const { rules, exampleId } = await learned(engine, 30);
    const store = new EditorStore(rules);
    const s = wire(engine, store, exampleId);
    await settled(store, s);

    // A formula column declared decimal that is really text: the model can't see this (it needs the engine's checker).
    const total = rules.output.columns.findIndex((c) => c.header === 'Total');
    const supplier = idOfInput(rules, 'Supplier');
    const r = store.apply({ type: 'setColumnMethod', index: total, method: { kind: 'formula', formula: `upper(${supplier})`, type: 'decimal' } });
    expect(r.ok).toBe(true);
    await settled(store, s, 'static');
    const blocked = status(store, s);
    expect(blocked.kind).toBe('blocked');
    if (blocked.kind !== 'blocked') return;
    expect(blocked.problems[0]).toMatchObject({ layer: 'types', lineId: 'col:Total', where: 'Column "Total"' });
    expect(blocked.problems[0]!.text).toContain('a number');
    expect(metaStatusOf(blocked)).toBeNull();
    store.undo();
    await settled(store, s, 'static');
    expect(status(store, s).kind).toBe('verified');
  });

  it('inside a format, an edit of the output side breaks the format lock and blocks saving', async () => {
    const engine = newEngine();
    const { rules, exampleId } = await learned(engine, 30);
    const { formatOf } = await import('@formatai/engine');
    const format: Format = formatOf(rules);
    const store = new EditorStore(rules, { format: { sourceCount: 3 } });
    const s = wire(engine, store, exampleId, { format });
    await settled(store, s, 'static');
    expect(s.getState().staticProblems).toEqual([]);

    store.apply({ type: 'setColumnHeader', index: 0, header: 'Vendor' });
    expect(store.getState().formatChange).toBe(true);
    await settled(store, s, 'static');
    const blocked = status(store, s);
    expect(blocked.kind).toBe('blocked');
    if (blocked.kind === 'blocked') expect(blocked.problems.some((p) => p.layer === 'formatLock')).toBe(true);
  });

  it('a worker that lost the example (it restarted): no example, the static checks still run', async () => {
    const engine = newEngine();
    const { rules } = await learned(engine, 20);
    const other = newEngine(); // a different worker: knows no example
    const store = new EditorStore(rules);
    const s = wire(other, store, 'from-a-dead-worker');
    await vi.waitFor(() => expect(s.getState().status).toBe('noExample'));
    expect(s.getState().staticProblems).toEqual([]);
    expect(status(store, s)).toEqual({ kind: 'noExample' });
    expect(metaStatusOf(status(store, s))).toBe('userConfirmed');
  });
});

describe('a big example: a subset live, every row on Apply', () => {
  it('checks 2,000 rows while editing and all rows on Apply', async () => {
    const engine = newEngine();
    const rows = editorConfig.fullCheckAboveRows + 400;
    const { rules, exampleId } = await learned(engine, rows);
    const store = new EditorStore(rules);
    const s = wire(engine, store, exampleId);
    await settled(store, s);
    expect(s.getState().live).toMatchObject({ partial: true, checkedInputRows: editorConfig.subsetRows, totalInputRows: rows, matched: editorConfig.subsetRows });
    expect(s.getState().full).toBeNull();
    expect(status(store, s)).toEqual({ kind: 'checking' }); // a partial check can't say "verified"

    const full = await s.apply();
    expect(full).toMatchObject({ partial: false, verified: true, matched: rows, total: rows });
    expect(status(store, s)).toEqual({ kind: 'verified' });

    // an edit makes the all-rows result out of date again
    store.apply({ type: 'setTitleRows', rows: [{ text: 'Report' }] });
    expect(status(store, s)).toEqual({ kind: 'checking' });
    await settled(store, s);
    expect(s.getState().live!.partial).toBe(true);
  }, 60_000);
});
