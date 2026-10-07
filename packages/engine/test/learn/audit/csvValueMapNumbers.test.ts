// Engine audit (2026-10-07), fix 9 (the root cause of stress finding O3): a value map is not built onto a column of numbers - it writes
// text, and a number tied to a key may be a figure of the group that changes next month. `outputHoldsNonText` (fastPath.ts) read the
// example's CELLS, and a csv / txt output's cells are all strings: the map was built and verified on a csv (`{"East":"285", ...}`) where
// the same pair in a workbook gave `thinEvidence`. Now a delimited output is judged by its profile type or a cell that is a plain number.
import { describe, expect, it } from 'vitest';
import { fastPath } from '../../../src/learn/fastPath';
import { partialRules } from '../../../src/learn/partial';
import { preflight } from '../../../src/learn/preflight';
import { analyzeOk, delimited, xlsx, type V } from '../analyze/helpers';

const REGIONS = ['East', 'West', 'North'];
const FIGURE: Record<string, number> = { East: 285, West: 112, North: 407 };

function rows(): { input: V[][]; output: V[][] } {
  const input: V[][] = [['Ref', 'Region', 'Qty']];
  const output: V[][] = [['Ref', 'Region', 'Figure']];
  for (let i = 0; i < 15; i++) {
    const region = REGIONS[i % 3]!;
    input.push([`R-${100 + i}`, region, 1 + ((i * 5) % 7)]);
    output.push([`R-${100 + i}`, region, FIGURE[region]!]);
  }
  return { input, output };
}

describe('no value map onto numbers, whatever the file type', () => {
  for (const type of ['xlsx', 'csv', 'txt'] as const) {
    it(`${type}: the figure column is not built (thin evidence), and the partial result leaves it to the AI step`, () => {
      const { input, output } = rows();
      const wb = (r: V[][]) => (type === 'xlsx' ? xlsx(r) : delimited(r, type));
      const a = analyzeOk(wb(input), wb(output));
      expect(a.columns[2]!.relations.some((r) => r.rel === 'valueMap')).toBe(true);
      const fp = fastPath(a, preflight(a, 'paid'));
      expect('rules' in fp).toBe(false);
      expect(fp).toMatchObject({ reason: 'thinEvidence', params: { column: 2, relation: 'valueMap' } });
      const partial = partialRules(a, preflight(a, 'paid'));
      if ('reason' in partial) throw new Error('no partial');
      expect(partial.rules.transform.valueMaps).toEqual([]);
      expect(partial.needsAi).toContain('Figure');
    });
  }

  it('csv: a value map onto text is still built', () => {
    const { input } = rows();
    const ZONE: Record<string, string> = { East: 'Coast', West: 'Hills', North: 'Plain' };
    const output: V[][] = [['Ref', 'Region', 'Zone'], ...input.slice(1).map((r) => [r[0]!, r[1]!, ZONE[r[1] as string]!])];
    const a = analyzeOk(delimited(input, 'csv'), delimited(output, 'csv'));
    const partial = partialRules(a, preflight(a, 'paid'));
    if ('reason' in partial) throw new Error('no partial');
    expect(partial.solved).toContain('Zone');
  });
});
