// "Download with these fields empty" runs the real conversion (the engine, in-process) on rules that still have columns with no rule:
// `from: null`, with or without an `unsupported` entry (the AI step's honest "can't produce this"). The file is made, the other columns are
// right, and the column is there - empty. Nothing about such a column stops the download.
import { readWorkbook } from '@formatai/engine';
import { describe, expect, it } from 'vitest';
import { ordersRules } from '../src/editor/testkit';
import { createEngineClient } from '../src/worker/engineClient';
import { engineMethods } from '../src/worker/engineMethods';
import { loopbackWorker } from './helpers/loopback';

const enc = (s: string): ArrayBuffer => {
  const u8 = new TextEncoder().encode(s);
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
};
const engine = () => createEngineClient({ createWorker: () => loopbackWorker(engineMethods) });

const INPUT = 'Item,Supplier,Qty,Unit price,Status,Shipped,Note\n12,Acme,3,2.50,open,05/01/2026,a\n7,Borealis,2,10,open,06/01/2026,b\n9,Acme,0,1,open,07/01/2026,c\n';

async function convertRows(rules: ReturnType<typeof ordersRules>) {
  const out = await engine().convert({ rules, file: { name: 'orders.csv', bytes: enc(INPUT) }, previewRows: 0 });
  if (!out.ok) throw new Error(`conversion failed: ${JSON.stringify(out.error)}`);
  const wb = await readWorkbook(new Uint8Array(out.bytes), 'out.xlsx');
  return wb.sheets[0]!.rows.map((r) => r.map((c) => c?.v ?? null));
}

describe('converting with columns that have no rule', () => {
  it('Remarks has no rule and the AI step reported it as unsupported (ordersRules as it is): the file is made, Remarks is there and empty', async () => {
    const rules = ordersRules();
    expect(rules.output.columns.find((c) => c.header === 'Remarks')!.from).toBeNull();
    expect(rules.unsupported).toHaveLength(1);
    const rows = await convertRows(rules);
    const header = rows.find((r) => r.includes('Remarks'))!;
    const at = header.indexOf('Remarks');
    expect(header.slice(0, 5)).toEqual(['Item', 'Supplier', 'Qty', 'Total', 'Shipped']);
    const data = rows.slice(rows.indexOf(header) + 1).filter((r) => r[0] !== null && r[0] !== 'Total');
    expect(data.length).toBe(2); // (Qty 0 is filtered by the rules)
    for (const r of data) expect(r[at] ?? null).toBeNull();
    expect(data.map((r) => r[0])).toEqual(['000007', '000012']);
  });

  it('a column with no rule and no entry in `unsupported` (what the free engine leaves) converts the same way', async () => {
    const rules = ordersRules();
    rules.unsupported = [];
    rules.output.columns = rules.output.columns.map((c) => (c.header === 'Total' || c.header === 'Shipped' ? { header: c.header, from: null } : c));
    rules.output.summaryRows = [];
    rules.transform.computed = [];
    rules.validations = [];
    rules.assumptions = [];
    const rows = await convertRows(rules);
    const header = rows.find((r) => r.includes('Total'))!;
    const data = rows.slice(rows.indexOf(header) + 1);
    expect(data.length).toBe(2);
    for (const r of data) {
      expect(r[header.indexOf('Total')] ?? null).toBeNull();
      expect(r[header.indexOf('Shipped')] ?? null).toBeNull();
      expect(r[header.indexOf('Qty')]).not.toBeNull();
    }
  });
});
