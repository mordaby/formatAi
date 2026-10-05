// Taking a column's rule out (`rules/copiedList.ts`): the one way code makes a column "needs your input" - the overfitting guards' fallback
// and the answer "a one-time edit" to a copied-list question (owner amendment, 2026-10-06). The column is left empty and reported, and what
// nothing reads any more goes with it: its computed column (and the helpers only it read), its lookup table, its value map.
import { describe, expect, it } from 'vitest';
import { COPIED_LIST_REASON, hasCopiedList, withColumnsTakenOut, withoutCopiedList, type CopiedListRule } from '../src/rules/copiedList';
import { LearnResultSchema, type Expr, type LearnResult } from '../src/rules/schema';

const col = (id: string): Expr => ({ col: id });
const lookup = (table: string, key: string, ret: string): Expr => ({ op: 'lookup', table, key: col(key), return: ret, onMissing: 'flag' });

function rules(extra: Partial<LearnResult['transform']> = {}, columns?: LearnResult['output']['columns']): LearnResult {
  return {
    schemaVersion: 1,
    input: {
      sheet: { pick: 'first' },
      headerRow: 'auto',
      columns: [
        { id: 'account', header: 'Account', type: 'text' },
        { id: 'company', header: 'Company', type: 'text' },
      ],
    },
    transform: {
      computed: [
        { id: 'accountKey', type: 'text', expr: { op: 'upper', arg: col('account') } },
        { id: 'manager', type: 'text', expr: lookup('managers', 'accountKey', 'manager') },
        { id: 'owner', type: 'text', expr: lookup('owners', 'company', 'owner') },
      ],
      valueMaps: [],
      sort: [],
      tables: [
        { name: 'managers', columns: ['accountKey', 'manager'], rows: [['ACC-1', 'Priya'], ['ACC-2', 'Tobias']] },
        { name: 'owners', columns: ['company', 'owner'], rows: [['Acme', 'Ava']] },
      ],
      ...extra,
    },
    output: {
      sheetName: 'S',
      direction: 'ltr',
      language: 'en',
      titleRows: [],
      columns: columns ?? [
        { header: 'Account', from: 'account' },
        { header: 'Owner', from: 'owner' },
        { header: 'Manager', from: 'manager' },
      ],
    },
    validations: [],
    unsupported: [],
    assumptions: [],
  };
}

const MANAGERS: CopiedListRule = { kind: 'lookup', computed: 'manager', table: 'managers' };

describe('withoutCopiedList: a lookup table', () => {
  it('the column is empty and needs your input (overfit); its computed column, the helper only it read, and its table go; the rest stays', () => {
    const out = withoutCopiedList(rules(), 'Manager', MANAGERS)!;
    expect(out.output.columns.find((c) => c.header === 'Manager')).toEqual({ header: 'Manager', from: null });
    expect(out.unsupported).toEqual([{ outputColumn: 'Manager', reasonCode: COPIED_LIST_REASON }]);
    expect(COPIED_LIST_REASON).toBe('overfit');
    expect(out.transform.computed.map((c) => c.id)).toEqual(['owner']);
    expect(out.transform.tables?.map((t) => t.name)).toEqual(['owners']);
    expect(LearnResultSchema.safeParse(out).success).toBe(true);
  });

  it('a table column named like the computed column is no reader of it', () => {
    const r = rules({ tables: [{ name: 'managers', columns: ['accountKey', 'manager'], rows: [['ACC-1', 'manager']] }, rules().transform.tables![1]!] });
    expect(withoutCopiedList(r, 'Manager', MANAGERS)!.transform.computed.map((c) => c.id)).toEqual(['owner']);
  });

  it('what something else still reads stays: a check on the computed column keeps it and its table', () => {
    const r = { ...rules(), validations: [{ column: 'manager', rule: 'required' as const, severity: 'flag' as const }] };
    const out = withoutCopiedList(r, 'Manager', MANAGERS)!;
    expect(out.output.columns.find((c) => c.header === 'Manager')?.from).toBeNull();
    expect(out.transform.computed.map((c) => c.id)).toEqual(['accountKey', 'manager', 'owner']);
    expect(out.transform.tables?.map((t) => t.name)).toEqual(['managers', 'owners']);
  });

  it('only while the column takes its value from the list: null once it was changed, emptied or answered', () => {
    expect(hasCopiedList(rules(), 'Manager', MANAGERS)).toBe(true);
    expect(hasCopiedList(rules(), 'Owner', MANAGERS)).toBe(false);
    expect(withoutCopiedList(rules({}, [{ header: 'Manager', from: 'account' }]), 'Manager', MANAGERS)).toBeNull();
    expect(withoutCopiedList(rules({}, [{ header: 'Manager', from: null }]), 'Manager', MANAGERS)).toBeNull();
    expect(withoutCopiedList(rules({ tables: [] }), 'Manager', MANAGERS)).toBeNull();
    const once = withoutCopiedList(rules(), 'Manager', MANAGERS)!;
    expect(withoutCopiedList(once, 'Manager', MANAGERS)).toBeNull();
  });
});

describe('withoutCopiedList: a value map', () => {
  const MAP: CopiedListRule = { kind: 'valueMap', column: 'account' };
  const mapped = (columns: LearnResult['output']['columns'], validations: LearnResult['validations'] = []): LearnResult => ({
    ...rules({ computed: [], tables: [], valueMaps: [{ column: 'account', map: { 'ACC-1': 'Priya', 'ACC-2': 'Tobias' }, onMissing: 'flag' }] }, columns),
    validations,
  });

  it('goes with the column when nothing else reads its column', () => {
    const out = withoutCopiedList(mapped([{ header: 'Company', from: 'company' }, { header: 'Manager', from: 'account' }]), 'Manager', MAP)!;
    expect(out.output.columns[1]).toEqual({ header: 'Manager', from: null });
    expect(out.unsupported).toEqual([{ outputColumn: 'Manager', reasonCode: 'overfit' }]);
    expect(out.transform.valueMaps).toEqual([]);
  });

  it('stays when another output column or a check still reads its column', () => {
    const two = withoutCopiedList(mapped([{ header: 'Manager', from: 'account' }, { header: 'Manager 2', from: 'account' }]), 'Manager', MAP)!;
    expect(two.transform.valueMaps).toHaveLength(1);
    const checked = withoutCopiedList(mapped([{ header: 'Manager', from: 'account' }], [{ column: 'account', rule: 'required', severity: 'flag' }]), 'Manager', MAP)!;
    expect(checked.transform.valueMaps).toHaveLength(1);
  });
});

describe('withoutCopiedList: a chain of cases on one column (owner amendment, 2026-10-06)', () => {
  const eq = (v: string): Expr => ({ op: 'eq', args: [col('account'), { const: v }] });
  const chain: Expr = { op: 'switch', cases: [{ when: { op: 'or', args: [eq('ACC-1'), eq('ACC-2')] }, then: { const: 'Priya' } }, { when: eq('ACC-3'), then: { const: 'Tobias' } }], else: { const: 'Amara' } };
  const CASES: CopiedListRule = { kind: 'cases', computed: 'manager', column: 'account' };
  const listed = (expr: Expr): LearnResult => {
    const r = rules();
    return { ...r, transform: { ...r.transform, computed: [r.transform.computed[2]!, { id: 'manager', type: 'text', expr }] } };
  };

  it('the column is empty and needs your input; its computed column goes with every value it named', () => {
    const out = withoutCopiedList(listed(chain), 'Manager', CASES)!;
    expect(out.output.columns[2]).toEqual({ header: 'Manager', from: null });
    expect(out.unsupported).toEqual([{ outputColumn: 'Manager', reasonCode: 'overfit' }]);
    expect(out.transform.computed.map((c) => c.id)).toEqual(['owner']);
    expect(JSON.stringify(out)).not.toContain('ACC-');
  });

  it('only while the column is still that chain on that column', () => {
    expect(hasCopiedList(listed(chain), 'Manager', CASES)).toBe(true);
    expect(hasCopiedList(listed({ op: 'upper', arg: col('account') }), 'Manager', CASES)).toBe(false);
    expect(hasCopiedList(listed(chain), 'Manager', { ...CASES, column: 'company' })).toBe(false);
  });
});

describe('withColumnsTakenOut', () => {
  it('a column already reported keeps its entry; several columns at once; nothing freed, nothing removed', () => {
    const r = { ...rules(), unsupported: [{ outputColumn: 'Owner', reasonCode: 'externalData' as const }] };
    const out = withColumnsTakenOut(r, new Set(['Owner', 'Manager']), 'overfit', []);
    expect(out.output.columns.map((c) => c.from)).toEqual(['account', null, null]);
    expect(out.unsupported).toEqual([
      { outputColumn: 'Owner', reasonCode: 'externalData' },
      { outputColumn: 'Manager', reasonCode: 'overfit' },
    ]);
    // (No computed column was named as freed: they stay - and so do the tables they look up.)
    expect(out.transform.computed).toHaveLength(3);
    expect(out.transform.tables).toHaveLength(2);
  });
});
