// "See what we send" before the learn (owner, 2026-10-07), in the worker: the preview is built by the learn's own code with the session's
// masking key, so its rows ARE the learn's first request - with no choice, and with the user's choices (an identifier sent as it is, a
// measure hidden), which the learn then applies to its request too. The real engine methods, through the real worker RPC, in-process.
import type { LearnPayload, PayloadCell } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import type { UserColumnChoices } from '@formatai/engine';
import type { LearnOutput, SendPreviewOutput, SentColumns } from '../src/worker/engineApi';
import { engineMethods } from '../src/worker/engineMethods';
import { loopback } from './helpers/loopback';
import { IDS, idPair, QTY } from './helpers/sendPreviewKit';

const enc = (s: string): ArrayBuffer => {
  const u8 = new TextEncoder().encode(s);
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
};

function files() {
  const pair = idPair();
  const input = enc(pair.input);
  const output = enc(pair.output);
  return { input: { name: 'in.csv', bytes: input }, output: { name: 'out.csv', bytes: output }, transfer: [input, output] };
}

/** The learn's first request - and the columns "what was sent" lists beside it (hidden or sent as they are). */
let lastColumns: SentColumns | undefined;
async function learnPayload(client: ReturnType<typeof loopback>, choices?: UserColumnChoices): Promise<LearnPayload> {
  const { input, output, transfer } = files();
  let sent: LearnPayload | undefined;
  const callLearn = async (payload: LearnPayload, columns?: SentColumns) => {
    sent = payload;
    lastColumns = columns;
    return { rules: null, problems: [], calls: [] };
  };
  await client.call<LearnOutput>('learn', { input, output, masking: true, tier: 'paid', ...(choices ? { columnChoices: choices } : {}) }, { transfer, host: { callLearn } });
  if (!sent) throw new Error('the learn sent nothing');
  return sent;
}

const ids = (cells: readonly PayloadCell[][]): string[] => cells.map((c) => String(c[0]));

describe('the send preview, in the worker', () => {
  it('reads and analyzes the files once (with progress), then builds again from the id; its rows are the learn\'s first request', async () => {
    const client = loopback(engineMethods);
    const { input, output, transfer } = files();
    const progress: unknown[] = [];
    const first = await client.call<SendPreviewOutput>('sendPreview', { input, output, masking: true, tier: 'paid' }, { transfer, onProgress: (p) => progress.push(p) });
    expect(first.ok).toBe(true);
    if (!first.ok || first.status !== 'ready') throw new Error('no preview');
    expect(progress.length).toBeGreaterThan(0);
    // The defaults: the IDs and the names hidden, the quantities sent.
    expect(first.columns.input.map((c) => [c.header, c.hidden, c.canHide])).toEqual([
      ['ID', true, true],
      ['Name', true, true],
      ['Qty', false, true],
    ]);
    expect(ids(first.payload.samples.map((s) => s.in)).some((v) => IDS.includes(v))).toBe(false);
    expect(first.payload.samples.every((s) => QTY.map(String).includes(String(s.in[2])))).toBe(true); // (a CSV cell is text)
    // The learn's own first request, value for value (the same key: one per worker session).
    expect(first.payload).toEqual(await learnPayload(client));

    // A switch flipped: the id only, no files.
    const choices: UserColumnChoices = { input: { 0: 'sent', 2: 'hidden' }, output: { 0: 'sent' } };
    const next = await client.call<SendPreviewOutput>('sendPreview', { previewId: first.previewId, masking: true, tier: 'paid', choices });
    if (!next.ok || next.status !== 'ready') throw new Error('no preview');
    expect(next.previewId).toBe(first.previewId);
    expect(next.columns.input.map((c) => c.hidden)).toEqual([false, true, true]);
    expect(next.columns.output[0]!.hidden).toBe(false); // the copy goes with it
    for (const s of next.payload.samples) {
      const k = IDS.indexOf(String(s.in[0]));
      expect(k).toBeGreaterThanOrEqual(0); // the ID: real
      expect(String(s.in[2])).not.toBe(String(QTY[k])); // the quantity: hidden
    }
    // ... and the learn with those choices sends exactly that, and "what was sent" lists the columns as chosen.
    expect(next.payload).toEqual(await learnPayload(client, choices));
    expect(lastColumns?.input.map((c) => c.hidden)).toEqual([false, true, true]);
    expect(lastColumns?.output.map((c) => c.hidden)).toEqual([false, true, true]);
  });

  it('says `gone` for an id it does not hold when no files come with it; masking off hides nothing', async () => {
    const client = loopback(engineMethods);
    expect(await client.call<SendPreviewOutput>('sendPreview', { previewId: 'not-held', masking: true, tier: 'paid' })).toEqual({ ok: false, reason: 'gone' });
    const { input, output, transfer } = files();
    const off = await client.call<SendPreviewOutput>('sendPreview', { input, output, masking: false, tier: 'paid', choices: { input: { 2: 'hidden' } } }, { transfer });
    if (!off.ok || off.status !== 'ready') throw new Error('no preview');
    expect([...off.columns.input, ...off.columns.output].every((c) => !c.hidden)).toBe(true);
    expect(off.payload.masking).toBe(false);
    expect(ids(off.payload.samples.map((s) => s.in)).every((v) => IDS.includes(v))).toBe(true);
  });
});
