// What every save stores of the rules (owner rule, 2026-10-06; `api/savedRules.ts`): a lookup table or a value map nothing in the rules
// reads any more is never saved - on every path, at the API clients: a new format, a new source, a new version (the editor), and the Run
// screen's "Do this every time?". A table that is still read is kept, and a normal format's body is sent exactly as it is.
import type { LearnResult, Rules } from '@formatai/shared';
import { describe, expect, it, vi } from 'vitest';
import { createConvertApi } from '../src/api/convert';
import { createRegistryApi } from '../src/api/registry';
import { ordersRules } from '../src/editor/testkit';

/** Account and a Manager looked up by Account in a table of the example's 40 accounts (`left`: Manager left empty by hand, its table behind). */
function managed(left = false): Rules {
  const base = ordersRules();
  return {
    ...base,
    transform: {
      ...base.transform,
      computed: [...base.transform.computed, ...(left ? [] : [{ id: 'manager', type: 'text' as const, expr: { op: 'lookup' as const, table: 'managers', key: { col: 'sku' }, return: 'manager', onMissing: 'flag' as const } }])],
      tables: [{ name: 'managers', columns: ['sku', 'manager'], rows: Array.from({ length: 40 }, (_, i) => [`ACC-${1001 + i}`, `Manager ${i % 8}`]) }],
    },
    output: { ...base.output, columns: [...base.output.columns, { header: 'Manager', from: left ? null : 'manager' }] },
  };
}

const base = { status: 'userConfirmed' as const, acceptedDifferences: 0, exampleExceptions: [], learnPath: 'llm' as const, masking: true };

/** Sends `rules` through every save of the two clients; what each one sent. */
async function sentBy(rules: Rules | LearnResult): Promise<Rules[]> {
  const request = vi.fn(async () => ({}));
  const registry = createRegistryApi(request as never);
  await registry.createFormat({ ...base, name: 'Accounts', rules } as never);
  await registry.attachSource('F1', { ...base, rules } as never);
  await registry.updateConversion('C1', { rules, status: 'userConfirmed', acceptedDifferences: 0, baseVersion: 1 } as never);
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
  const convert = createConvertApi({ baseUrl: 'https://api.test', fetch: fetchMock as unknown as typeof fetch });
  await convert.saveRules('C1', { rules: rules as Rules, status: 'verified', acceptedDifferences: 0, exampleExceptions: [], baseVersion: 1 });
  const viaRegistry = (request.mock.calls as unknown as [string, string, { rules: Rules }][]).map((c) => c[2].rules);
  const viaConvert = (fetchMock.mock.calls as unknown as [string, RequestInit][]).map(([, init]) => (JSON.parse(String(init.body)) as { rules: Rules }).rules);
  return [...viaRegistry, ...viaConvert];
}

describe('a lookup table or value map nothing reads any more is never saved', () => {
  it('a list whose column was left empty by hand: no table and no copied value is sent, on any save path', async () => {
    const sent = await sentBy(managed(true));
    expect(sent).toHaveLength(4);
    for (const rules of sent) {
      expect(rules.transform.tables).toEqual([]);
      expect(JSON.stringify(rules)).not.toMatch(/Manager \d|ACC-/);
      // Everything else as it was.
      expect({ ...rules, transform: { ...rules.transform, tables: managed(true).transform.tables } }).toEqual(managed(true));
    }
  });

  it('a value map on a column nothing reads any more goes too; one on a column that is read stays', async () => {
    const orders = ordersRules();
    // (Note is declared, and nothing reads it; Supplier's map is read by the Supplier column)
    const unread = { column: 'note', map: { 'ACC-1001': 'Manager 0' }, onMissing: 'flag' as const };
    const withMap: Rules = { ...orders, transform: { ...orders.transform, valueMaps: [...orders.transform.valueMaps, unread] } };
    for (const rules of await sentBy(withMap)) expect(rules.transform.valueMaps).toEqual(orders.transform.valueMaps);
  });

  it('a table that is still read is kept', async () => {
    for (const rules of await sentBy(managed())) expect(rules).toEqual(managed());
  });

  it('a normal format\'s save body is unchanged (the same rules object, where nothing is serialized)', async () => {
    const rules = ordersRules();
    const request = vi.fn(async () => ({}));
    const registry = createRegistryApi(request as never);
    const body = { ...base, name: 'Orders', rules };
    await registry.createFormat(body as never);
    expect((request.mock.calls[0] as unknown as [string, string, unknown])[2]).toEqual(body);
    expect((request.mock.calls[0] as unknown as [string, string, { rules: Rules }])[2].rules).toBe(rules);
    for (const sent of await sentBy(rules)) expect(sent).toEqual(rules);
  });
});
