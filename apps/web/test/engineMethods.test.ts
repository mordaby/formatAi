// The real engine methods (the worker's `learn` / `convert` / `verify`) run through the real
// RPC runtime and client, in-process. This is not a substitute for the browser check (the
// bundling of ExcelJS/SheetJS for a real Worker), but it pins the behaviour of the methods:
// progress, the masking key, host calls, and the transfer of bytes.
import type { LearnPayload, LearnResult } from '@formatai/shared';
import { describe, expect, it, vi } from 'vitest';
import type { ConvertOutput, LearnOutput, LearnProgress, VerifyOutput } from '../src/worker/engineApi';
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

  it('learn: off the fast path the worker asks the main thread (host) to call the API, with a masked payload', async () => {
    const client = loopback(engineMethods);
    const payloads: LearnPayload[] = [];
    const progress: LearnProgress[] = [];
    const callLearn = vi.fn(async (payload: LearnPayload) => {
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

    // The masking key is the worker's own, stable for the session: the same pair masks to the same fake words.
    const again = learnArgs(llmPair(), true);
    await client.call('learn', again.args, { transfer: again.transfer, host: { callLearn } });
    expect(JSON.stringify(payloads[1])).toBe(sent);
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

  it('verify: re-checks rules against the example pair (for the editor)', async () => {
    const client = loopback(engineMethods);
    const learn = learnArgs(renamePair(), true);
    const learned = await client.call<LearnOutput>('learn', learn.args, { transfer: learn.transfer });

    const again = learnArgs(renamePair(), true);
    const out = await client.call<VerifyOutput>('verify', { input: again.args.input, output: again.args.output, rules: learned.rules as LearnResult }, { transfer: again.transfer });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.verification.verified).toBe(true);
  });
});
