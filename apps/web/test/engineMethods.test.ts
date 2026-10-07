// The real engine methods (the worker's `learn` / `convert` / `loadExample`) run through the real
// RPC runtime and client, in-process. This is not a substitute for the browser check (the
// bundling of ExcelJS/SheetJS for a real Worker), but it pins the behaviour of the methods:
// progress, the masking key, host calls, and the transfer of bytes.
import { completionPlan, formulaRulesFromWire } from '@formatai/engine';
import { fromWire, LearnResultSchema, type LearnPayload, type LearnResult } from '@formatai/shared';
import { describe, expect, it, vi } from 'vitest';
import type { ConvertOutput, LearnOutput, LearnProgress, LoadExampleOutput } from '../src/worker/engineApi';
import { engineMethods } from '../src/worker/engineMethods';
import { RpcRemoteError } from '../src/worker/rpcClient';
import { loopback } from './helpers/loopback';

const enc = (s: string): ArrayBuffer => {
  const u8 = new TextEncoder().encode(s);
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
};

const FIRST = ['Gal', 'Julia', 'Anna', 'Dana', 'Omer', 'Lior', 'Shani', 'Yuval'];
const LAST = ['Young', 'Levi', 'Haddad', 'Abraham', 'Cohen', 'Smith', 'Taylor', 'Wilson'];

/** A rename + reorder pair: the local fast path solves it with no LLM (SPEC 6.5). */
function renamePair(prefix = 'C') {
  const rows = FIRST.map((f, i) => ({ id: `${prefix}-${1000 + i}`, f, l: LAST[i]!, email: `${f}.${LAST[i]}@example.com`.toLowerCase() }));
  return {
    input: 'Customer ID,First Name,Last Name,Email\n' + rows.map((r) => `${r.id},${r.f},${r.l},${r.email}`).join('\n') + '\n',
    output: 'Contact ID,Last Name,First Name,Email Address\n' + rows.map((r) => `${r.id},${r.l},${r.f},${r.email}`).join('\n') + '\n',
  };
}

/** The check digit that makes a 9-digit Israeli ID number valid, for the 8 digits before it. */
function withCheckDigit(eight: string): string {
  let sum = 0;
  [...eight].forEach((ch, i) => {
    const n = Number(ch) * (i % 2 === 0 ? 1 : 2);
    sum += n > 9 ? n - 9 : n;
  });
  return eight + String((10 - (sum % 10)) % 10);
}

/** The rename pair, but the input also has an ID number column (some with their leading zero lost) that the output leaves out. */
function withUnusedIdColumn() {
  const ids = Array.from({ length: 8 }, (_, i) => {
    const id = withCheckDigit(i < 2 ? `0${String(1234567 + i)}` : String(31234567 + i)); // two of them start with 0
    return id.replace(/^0+/, ''); // stored as a number: the leading zero is lost
  });
  const rows = FIRST.map((f, i) => ({ id: `C-${1000 + i}`, f, l: LAST[i]!, national: ids[i]! }));
  return {
    input: 'Customer ID,First Name,Last Name,ID Number\n' + rows.map((r) => `${r.id},${r.f},${r.l},${r.national}`).join('\n') + '\n',
    output: 'Contact ID,Last Name,First Name\n' + rows.map((r) => `${r.id},${r.l},${r.f}`).join('\n') + '\n',
  };
}

/** Output "Size" is a rule on Qty that no single relation explains: the fast path gives up, the LLM would be asked. */
function llmPair() {
  const items = ['Kumquat', 'Zeppelin', 'Marzipan', 'Quokka', 'Lozenge', 'Buttress', 'Gazebo', 'Nutmeg', 'Cobbler', 'Trestle'];
  const qty = [3, 12, 7, 25, 1, 40, 9, 15, 2, 30];
  return {
    input: 'Item,Qty\n' + items.map((n, i) => `${n},${qty[i]}`).join('\n') + '\n',
    output: 'Item,Size\n' + items.map((n, i) => `${n},${qty[i]! >= 10 ? 'bulk' : 'single'}`).join('\n') + '\n',
  };
}

function learnArgs(pair: { input: string; output: string }, masking: boolean) {
  const input = enc(pair.input);
  const output = enc(pair.output);
  return { args: { input: { name: 'in.csv', bytes: input }, output: { name: 'out.csv', bytes: output }, masking, tier: 'paid' as const }, transfer: [input, output] };
}

describe('engine methods, through the worker RPC', () => {
  it('learn: solves a rename/reorder on the local fast path, verified, with no host call', async () => {
    const client = loopback(engineMethods);
    const callLearn = vi.fn();
    const progress: LearnProgress[] = [];
    const { args, transfer } = learnArgs(renamePair(), true);
    const res = await client.call<LearnOutput>('learn', args, { transfer, host: { callLearn }, onProgress: (p) => progress.push(p as LearnProgress) });

    expect(res.path).toBe('local');
    expect(res.verification?.verified).toBe(true);
    expect(res.verification?.matched).toBe(res.verification?.total);
    expect(res.rules?.output.columns.map((c) => c.header)).toEqual(['Contact ID', 'Last Name', 'First Name', 'Email Address']);
    expect(callLearn).not.toHaveBeenCalled();

    // Real progress: `reading` first, then analysis stages up to done; no learning/verifying on this path.
    expect(progress[0]).toEqual({ phase: 'reading' });
    const phases = new Set(progress.map((p) => p.phase));
    expect(phases).toEqual(new Set(['reading', 'checking']));
    const fractions = progress.flatMap((p) => (p.phase === 'checking' ? [p.fraction] : []));
    expect(fractions.length).toBeGreaterThan(2);
    expect(fractions).toEqual([...fractions].sort((a, b) => a - b));
    expect(fractions[fractions.length - 1]).toBe(1);
  });

  it('learn: hands the editor the columns of the example input, including one no rule uses (headers and facts about the values only)', async () => {
    const client = loopback(engineMethods);
    const pair = withUnusedIdColumn();
    const { args, transfer } = learnArgs(pair, true);
    const res = await client.call<LearnOutput>('learn', args, { transfer });

    expect(res.path).toBe('local');
    // No learned rule reads the ID number, so the rules do not declare it...
    expect(res.rules?.input.columns.map((c) => c.header)).not.toContain('ID Number');
    // ...but the example input's columns come with the result, in file order, so a dropdown can still offer it.
    expect(res.exampleInput?.map((c) => c.header)).toEqual(['Customer ID', 'First Name', 'Last Name', 'ID Number']);
    expect(res.exampleInput?.find((c) => c.header === 'ID Number')).toMatchObject({ type: 'idLike', israeliId: true, leadingZerosLost: true, maxLength: 9 });
    expect(res.exampleInput?.find((c) => c.header === 'First Name')).toMatchObject({ type: 'text' });
    // Nothing but headers and facts: none of the cell values are in it.
    expect(JSON.stringify(res.exampleInput)).not.toContain('Gal');
    expect(res.exampleId).toBeTruthy();
  });

  it('loadExample: reads the example files of a saved source again and returns the same columns', async () => {
    const client = loopback(engineMethods);
    const pair = withUnusedIdColumn();
    const input = enc(pair.input);
    const output = enc(pair.output);
    const res = await client.call<LoadExampleOutput>('loadExample', { input: { name: 'in.csv', bytes: input }, output: { name: 'out.csv', bytes: output } }, { transfer: [input, output] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.exampleInput.map((c) => c.header)).toEqual(['Customer ID', 'First Name', 'Last Name', 'ID Number']);
    expect(res.exampleInput.find((c) => c.header === 'ID Number')).toMatchObject({ type: 'idLike', israeliId: true });
  });

  it('learn: moves the file bytes to the worker (the caller no longer holds them)', async () => {
    const client = loopback(engineMethods);
    const { args, transfer } = learnArgs(renamePair(), false);
    await client.call('learn', args, { transfer });
    expect(args.input.bytes.byteLength).toBe(0);
    expect(args.output.bytes.byteLength).toBe(0);
  });

  it('learn: an unsupported file type is a coded error', async () => {
    const client = loopback(engineMethods);
    const { args, transfer } = learnArgs(renamePair(), false);
    args.input.name = 'report.pdf';
    const err = await client.call('learn', args, { transfer }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcRemoteError);
    expect((err as RpcRemoteError).code).toBe('unsupportedFileType');
  });

  it('learn-v8: a second rule the answer gave that also fits every row becomes the ambiguity question the result screen asks', async () => {
    const client = loopback(engineMethods);
    const size = (op: 'gte' | 'gt', n: number) => ({ op, args: [{ col: 'qty' }, { const: n }] });
    const callLearn = vi.fn(async () => {
      const answer: LearnResult = {
        schemaVersion: 1,
        input: { sheet: { pick: 'first' }, headerRow: 'auto', columns: [{ id: 'item', header: 'Item', type: 'text' }, { id: 'qty', header: 'Qty', type: 'integer' }] },
        transform: { computed: [{ id: 'size', type: 'text', expr: { op: 'if', cond: size('gte', 10), then: { const: 'bulk' }, else: { const: 'single' } } as LearnResult['transform']['computed'][number]['expr'] }], valueMaps: [], sort: [] },
        output: { sheetName: 'Sheet1', direction: 'ltr', language: 'en', titleRows: [], columns: [{ header: 'Item', from: 'item' }, { header: 'Size', from: 'size' }] },
        validations: [],
        unsupported: [],
        assumptions: [],
      };
      const other = { op: 'if', cond: size('gt', 9), then: { const: 'bulk' }, else: { const: 'single' } } as LearnResult['transform']['computed'][number]['expr'];
      return { rules: answer, alternatives: [{ outputColumn: 'Size', from: 'sizeAlt', computed: [{ id: 'sizeAlt', type: 'text' as const, expr: other }] }], problems: [], calls: [] };
    });
    const { args, transfer } = learnArgs(llmPair(), false);
    // (The answer declares no csv output file, so the loop may ask for a round: nothing comes back from it.)
    const callRepair = vi.fn(async () => ({ rules: null, problems: [], calls: [] }));
    const res = await client.call<LearnOutput>('learn', args, { transfer, host: { callLearn, callRepair } });
    expect(res.alternatives?.map((a) => [a.column, a.outcome])).toEqual([['Size', 'bothPass']]);
    expect(res.ambiguous?.map((q) => [q.header, q.readings.map((r) => r.kind)])).toEqual([['Size', ['rule', 'alternative']]]);
    expect(res.rules!.validations.filter((v) => v.rule === 'sameAs')).toEqual([res.ambiguous![0]!.check]);
  });

  it('learn: off the fast path the worker asks the main thread (host) to call the API, with a masked payload', async () => {
    const client = loopback(engineMethods);
    const payloads: LearnPayload[] = [];
    const progress: LearnProgress[] = [];
    const callLearn = vi.fn(async (payload: LearnPayload, _columns?: unknown) => {
      payloads.push(payload);
      return { rules: null, problems: [], calls: [] };
    });

    const { args, transfer } = learnArgs(llmPair(), true);
    const res = await client.call<LearnOutput>('learn', args, { transfer, host: { callLearn }, onProgress: (p) => progress.push(p as LearnProgress) });

    expect(callLearn).toHaveBeenCalledTimes(1);
    expect(res.path).toBe('llm');
    expect(res.rules).toBeNull(); // the fake server returned nothing usable
    expect(progress.map((p) => p.phase)).toContain('learning');
    expect(progress.map((p) => p.phase)).toContain('verifying');

    // Masking on: no real word (of the text column) is in what would be sent; numbers and headers are.
    const sent = JSON.stringify(payloads[0]);
    for (const word of ['Kumquat', 'Zeppelin', 'Marzipan', 'Quokka']) expect(sent).not.toContain(word);
    expect(payloads[0]!.masking).toBe(true);
    expect(sent).toContain('"Item"');
    expect(sent).toContain('"Qty"');
    // "See what we send": with the payload, which columns masking hides (the column classification) - never part of the payload.
    expect(callLearn.mock.calls[0]![1]).toEqual({
      input: [{ header: 'Item', hidden: true }, { header: 'Qty', hidden: false }],
      output: [{ header: 'Item', hidden: true }, { header: 'Size', hidden: true }],
    });
    expect(sent).not.toContain('"hidden"');

    // The masking key is the worker's own, stable for the session: the same pair masks to the same fake words.
    const again = learnArgs(llmPair(), true);
    await client.call('learn', again.args, { transfer: again.transfer, host: { callLearn } });
    expect(JSON.stringify(payloads[1])).toBe(sent);
  });

  it('learn in completion mode: the rules to keep go out as complete.fixed, the example of the screen is kept under its id, and the answer comes back with the lock and what it produced', async () => {
    const client = loopback(engineMethods);
    // The local result first (what a visitor gets): Item is built, Size needs the AI step.
    const local = learnArgs(llmPair(), false);
    const first = await client.call<LearnOutput>('learn', { ...local.args, ai: 'notAllowed' as const }, { transfer: local.transfer });
    expect(first.path).toBe('partial');
    expect(first.exampleOutputColumns).toBe(2);
    const plan = completionPlan(first.rules!, { parts: first.partial!.needsAiParts });
    expect(plan.columns).toEqual([1]);

    // Then the AI step, for that column only. The fake server answers with the fixed rules plus a rule for Size.
    const payloads: LearnPayload[] = [];
    const callLearn = vi.fn(async (payload: LearnPayload) => {
      payloads.push(payload);
      const fixed = LearnResultSchema.parse(formulaRulesFromWire(fromWire(payload.complete!.fixed)).rules);
      const answer: LearnResult = {
        ...fixed,
        input: { ...fixed.input, columns: [...fixed.input.columns, { id: 'qty', header: 'Qty', type: 'integer' }] },
        transform: {
          ...fixed.transform,
          computed: [...fixed.transform.computed, { id: 'size', type: 'text', expr: { op: 'if', cond: { op: 'gte', args: [{ col: 'qty' }, { const: 10 }] }, then: { const: 'bulk' }, else: { const: 'single' } } }],
        },
        output: { ...fixed.output, columns: fixed.output.columns.map((c) => (c.header === 'Size' ? { ...c, from: 'size' } : c)) },
      };
      return { rules: answer, problems: [], calls: [] };
    });
    const again = learnArgs(llmPair(), false);
    const res = await client.call<LearnOutput>(
      'learn',
      { ...again.args, ai: 'allowed' as const, complete: { fixedRules: first.rules!, columns: plan.columns, parts: plan.parts }, keepExampleId: first.exampleId },
      { transfer: again.transfer, host: { callLearn } },
    );

    expect(callLearn).toHaveBeenCalledTimes(1);
    expect(payloads[0]!.complete).toMatchObject({ columns: [1], parts: [] });
    expect(res.path).toBe('llm');
    expect(res.completion).toEqual({ columns: [1], parts: [], fixedProblems: [], matches: true, produced: { columns: 1, parts: 0 } });
    expect(res.verification?.verified).toBe(true);
    // The Result screen's live check goes on with the example it already holds.
    expect(res.exampleId).toBe(first.exampleId);
  });

  it('learn: an AI answer whose day/month order no date settles comes back with the question for it (`ambiguous`), made from the fill\'s ambiguity', async () => {
    const client = loopback(engineMethods);
    // Every date reads both ways (no part above 12), so the example cannot say whether "05/03/2026" is 5 March or 3 May.
    const dates = ['05/03/2026', '01/04/2026', '02/01/2026', '07/08/2026', '03/06/2026', '04/05/2026', '09/02/2026', '06/07/2026'];
    const pair = {
      input: 'Ref,When\n' + dates.map((d, i) => `R${100 + i},${d}`).join('\n') + '\n',
      output: 'Ref,Label\n' + dates.map((d, i) => `R${100 + i},M-${d.split('/')[1]}`).join('\n') + '\n',
    };
    // The answer reads the dates day first.
    const callLearn = vi.fn(async () => {
      const answer: LearnResult = {
        schemaVersion: 1,
        input: {
          sheet: { pick: 'first' },
          headerRow: 'auto',
          columns: [{ id: 'ref', header: 'Ref', type: 'text' }, { id: 'when', header: 'When', type: 'text' }],
        },
        transform: {
          computed: [
            {
              id: 'label',
              type: 'text',
              expr: { op: 'concat', args: [{ const: 'M-' }, { op: 'dateFormat', arg: { op: 'toDate', arg: { col: 'when' }, format: 'DD/MM/YYYY' }, format: 'MM' }] },
            },
          ],
          valueMaps: [],
          sort: [],
        },
        output: {
          file: { type: 'csv', delimiter: ',', encoding: 'utf8', quote: 'minimal', header: true },
          sheetName: 'Sheet1',
          direction: 'ltr',
          language: 'en',
          titleRows: [],
          columns: [{ header: 'Ref', from: 'ref' }, { header: 'Label', from: 'label' }],
        },
        validations: [],
        unsupported: [],
        assumptions: [],
      };
      return { rules: answer, problems: [], calls: [] };
    });
    const { args, transfer } = learnArgs(pair, false);
    const res = await client.call<LearnOutput>('learn', { ...args, ai: 'allowed' as const }, { transfer, host: { callLearn } });
    expect(res.path).toBe('llm');
    expect(res.ambiguities).toEqual([{ kind: 'dayMonthOrder', column: 'When', format: 'DD/MM/YYYY', other: 'MM/DD/YYYY' }]);
    expect(res.ambiguous).toHaveLength(1);
    expect(res.ambiguous![0]).toMatchObject({ header: 'Label', defaultReading: 0, check: null });
    expect(res.ambiguous![0]!.readings.map((r) => [r.kind, r.columns, r.fragment.dateFormats])).toEqual([
      ['dayMonthOrder', ['When'], [{ column: 'When', from: 'MM/DD/YYYY', to: 'DD/MM/YYYY' }]],
      ['dayMonthOrder', ['When'], [{ column: 'When', from: 'DD/MM/YYYY', to: 'MM/DD/YYYY' }]],
    ]);
  });

  it('learn: masking off sends the sample rows as they are', async () => {
    const client = loopback(engineMethods);
    let sent = '';
    const { args, transfer } = learnArgs(llmPair(), false);
    await client.call('learn', args, {
      transfer,
      host: {
        callLearn: async (p: LearnPayload) => {
          sent = JSON.stringify(p);
          return { rules: null, problems: [], calls: [] };
        },
      },
    });
    expect(sent).toContain('Kumquat');
  });

  it('learn: rejects a host (API) failure as the same coded error, so the flow can map it', async () => {
    const client = loopback(engineMethods);
    const { args, transfer } = learnArgs(llmPair(), true);
    const err = await client
      .call('learn', args, { transfer, host: { callLearn: () => Promise.reject(Object.assign(new Error('limit'), { code: 'limitHit' })) } })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcRemoteError);
    expect((err as RpcRemoteError).code).toBe('limitHit');
  });

  it('convert: applies the learned rules to a new file and returns the output bytes plus a capped preview', async () => {
    const client = loopback(engineMethods);
    const learn = learnArgs(renamePair(), true);
    const learned = await client.call<LearnOutput>('learn', learn.args, { transfer: learn.transfer });

    const next = enc(renamePair('D').input);
    const out = await client.call<ConvertOutput>('convert', { rules: learned.rules as LearnResult, file: { name: 'next.csv', bytes: next }, previewRows: 3 }, { transfer: [next] });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const text = new TextDecoder().decode(out.bytes);
    expect(text.split(/\r?\n/)[0]).toBe('Contact ID,Last Name,First Name,Email Address');
    expect(text).toContain('D-1000,Young,Gal,gal.young@example.com');
    expect(out.summary.rowsIn).toBe(8);
    expect(out.summary.rowsOut).toBe(8);
    expect(out.preview.rows).toHaveLength(3);
    expect(out.totalRows).toBe(9); // header + 8 data rows
    expect(out.flags).toEqual([]);
  });

  it('convert: a file that does not fit the rules is a result, not a crash', async () => {
    const client = loopback(engineMethods);
    const learn = learnArgs(renamePair(), true);
    const learned = await client.call<LearnOutput>('learn', learn.args, { transfer: learn.transfer });

    const other = enc('Foo,Bar\n1,2\n3,4\n5,6\n');
    const out = await client.call<ConvertOutput>('convert', { rules: learned.rules as LearnResult, file: { name: 'other.csv', bytes: other }, previewRows: 5 }, { transfer: [other] });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe('missingRequiredColumns');
    expect(out.error.missing).toContain('Customer ID');
  });
});
