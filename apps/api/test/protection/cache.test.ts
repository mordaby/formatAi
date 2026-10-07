import { promptVersion, type LearnPayload, type LearnResult } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { canonicalJson, isCacheable, learnCacheKey, rulesHaveTextConstants } from '../../src/protection/cache.js';
import { basicPayload, correctRules } from '../learn/fixtures.js';

const key = (p: LearnPayload): string => learnCacheKey(p, promptVersion);

describe('learnCacheKey (SPEC 9.5: the structure only)', () => {
  it('API audit: changes with the prompt version the learn is sent (learn-v9 is not learn-v7)', () => {
    expect(learnCacheKey(basicPayload(), 'learn-v9')).not.toBe(key(basicPayload()));
    expect(learnCacheKey(basicPayload(), 'learn-v7')).toBe(key(basicPayload()));
    expect(promptVersion).toBe('learn-v7');
  });

  it('is a sha256 hex digest and stable across calls', () => {
    expect(key(basicPayload())).toMatch(/^[0-9a-f]{64}$/);
    expect(key(basicPayload())).toBe(key(basicPayload()));
  });

  it('ignores everything data-derived: samples, dropped rows, hints, stats, shapes, widths, sheet names', () => {
    const base = key(basicPayload());
    const p = basicPayload();
    p.samples = [{ in: ['ZZ9', 999], out: ['ZZ9', 1998] }];
    p.dropped = [['dropped', 1]];
    p.hints = [{ rel: 'copy', in: [0], out: 0, coverage: 1 }];
    p.input.columns[0]!.stats = { distinct: 0.5 };
    p.input.columns[0]!.shape = 'AD';
    p.output.columns[1]!.width = 30;
    p.input.sheetName = 'Report 2026-10';
    expect(key(p)).toBe(base);
  });

  it('changes with input headers and types', () => {
    const base = key(basicPayload());
    const renamed = basicPayload();
    renamed.input.columns[1]!.header = 'Amount USD';
    expect(key(renamed)).not.toBe(base);
    const retyped = basicPayload();
    retyped.input.columns[1]!.type = 'text';
    expect(key(retyped)).not.toBe(base);
  });

  it('changes with output headers, types and formats', () => {
    const base = key(basicPayload());
    const renamed = basicPayload();
    renamed.output.columns[1]!.header = 'Sum';
    expect(key(renamed)).not.toBe(base);
    const retyped = basicPayload();
    retyped.output.columns[1]!.type = 'integer';
    expect(key(retyped)).not.toBe(base);
    const formatted = basicPayload();
    formatted.output.columns[1]!.format = '#,##0.00';
    expect(key(formatted)).not.toBe(base);
  });

  it('changes with the output layout and output.file', () => {
    const base = key(basicPayload());
    const layout = basicPayload();
    layout.output.layout.titleRows = [{ row: 0, text: 'Monthly report', bold: true }];
    expect(key(layout)).not.toBe(base);
    const file = basicPayload();
    file.output.file = { type: 'csv', delimiter: ';' };
    expect(key(file)).not.toBe(base);
  });

  it('changes with the input layout, the masking flag and the target', () => {
    const base = key(basicPayload());
    const inputLayout = basicPayload();
    inputLayout.input.layout.rowsAbove = 2;
    expect(key(inputLayout)).not.toBe(base);
    expect(key(basicPayload({ masking: true }))).not.toBe(base);
    const target = basicPayload({
      target: { output: { columns: [{ header: 'ID' }] } as never, layout: {} as never, validations: [] },
    });
    expect(key(target)).not.toBe(base);
  });

  it('treats skipColumns as a set: order does not matter, membership does', () => {
    const a = basicPayload({ skipColumns: [1, 0] });
    const b = basicPayload({ skipColumns: [0, 1] });
    expect(key(a)).toBe(key(b));
    expect(key(basicPayload({ skipColumns: [1] }))).not.toBe(key(b));
    expect(key(basicPayload({ skipColumns: [] }))).toBe(key(basicPayload()));
  });
});

describe('canonicalJson', () => {
  it('sorts object keys recursively and drops undefined fields', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: undefined }], c: null } })).toBe(
      '{"a":{"c":null,"d":[3,{"z":1}]},"b":1}',
    );
  });
});

function withRules(mutate: (r: LearnResult) => void): LearnResult {
  const rules = correctRules();
  mutate(rules);
  return rules;
}

describe('rulesHaveTextConstants (the masking rule for cache hits)', () => {
  it('finds none in rules made of ids, headers, enum words and numbers', () => {
    expect(rulesHaveTextConstants(correctRules())).toBe(false);
  });

  it('finds a text constant in an expression', () => {
    const rules = withRules((r) => {
      r.transform.computed.push({ id: 'label', type: 'text', expr: { const: 'Paid' } });
    });
    expect(rulesHaveTextConstants(rules)).toBe(true);
  });

  it('ignores numeric, boolean and separator-only constants', () => {
    const rules = withRules((r) => {
      r.transform.computed.push(
        { id: 'sep', type: 'text', expr: { const: ' - ' } },
        { id: 'n', type: 'decimal', expr: { const: 7 } },
        { id: 'b', type: 'boolean', expr: { const: true } },
      );
    });
    expect(rulesHaveTextConstants(rules)).toBe(false);
  });

  it('finds value-map entries, whatever their keys are named', () => {
    const rules = withRules((r) => {
      r.transform.valueMaps.push({ column: 'id', map: { type: 'op' }, onMissing: 'keep' });
    });
    expect(rulesHaveTextConstants(rules)).toBe(true);
  });

  it('finds filter values, oneOf validation values, title text and summary labels', () => {
    expect(
      rulesHaveTextConstants(
        withRules((r) => {
          r.input.rowFilters = [{ column: 'id', op: 'eq', value: 'Cancelled' }];
        }),
      ),
    ).toBe(true);
    expect(
      rulesHaveTextConstants(
        withRules((r) => {
          r.validations.push({ column: 'id', rule: 'oneOf', values: ['A1'], severity: 'flag' });
        }),
      ),
    ).toBe(true);
    expect(
      rulesHaveTextConstants(
        withRules((r) => {
          r.output.titleRows = [{ text: 'Monthly report' }];
        }),
      ),
    ).toBe(true);
    expect(
      rulesHaveTextConstants(
        withRules((r) => {
          r.output.summaryRows = [{ label: 'Total', cells: { Total: 'sum' } }];
        }),
      ),
    ).toBe(true);
  });

  it('finds switch/replaceText/startsWith text and lookup-table cells', () => {
    expect(
      rulesHaveTextConstants(
        withRules((r) => {
          r.transform.computed[0]!.expr = {
            op: 'replaceText',
            arg: { col: 'id' },
            find: 'A',
            with: 'B',
          };
        }),
      ),
    ).toBe(true);
    expect(
      rulesHaveTextConstants(
        withRules((r) => {
          r.transform.tables = [{ name: 't', columns: ['k', 'v'], rows: [['x', 'y']] }];
        }),
      ),
    ).toBe(true);
  });

  it('does not count summary-row cells (output header -> aggregate name)', () => {
    const rules = withRules((r) => {
      r.output.summaryRows = [{ cells: { Total: 'sum' } }];
    });
    expect(rulesHaveTextConstants(rules)).toBe(false);
  });
});

describe('isCacheable', () => {
  const withConstant = withRules((r) => {
    r.transform.computed.push({ id: 'label', type: 'text', expr: { const: 'Paid' } });
  });

  it('with masking off, nothing is cacheable: its constants would be real values from the example (owner decision 2026-10-05)', () => {
    expect(isCacheable(withConstant, false)).toBe(false);
    expect(isCacheable(correctRules(), false)).toBe(false);
  });

  it('with masking on, only rules without text constants are cacheable', () => {
    expect(isCacheable(withConstant, true)).toBe(false);
    expect(isCacheable(correctRules(), true)).toBe(true);
  });
});
