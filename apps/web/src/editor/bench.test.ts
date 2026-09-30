// How long one edit takes on a big rules file (60 columns, 20 tables of 500 rows): the model runs on every keystroke.
import type { Rules } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { applyEdit, createEditorState } from './model';
import { ordersRules } from './testkit';

function big(): Rules {
  const r = ordersRules();
  const columns = Array.from({ length: 60 }, (_, i) => ({ header: `Column ${i}`, from: i % 2 === 0 ? 'qty' : 'price' }));
  const tables = Array.from({ length: 20 }, (_, t) => ({
    name: `table${t}`,
    columns: ['key', 'value', 'other'],
    rows: Array.from({ length: 500 }, (_, i) => [`k${i}`, i, `v${i}`]),
  }));
  return {
    ...r,
    transform: { ...r.transform, tables },
    output: { ...r.output, columns, summaryRows: [] },
    validations: [],
    unsupported: [],
    assumptions: [],
  };
}

describe('one edit on a big rules file', () => {
  it('stays fast enough for typing', () => {
    let state = createEditorState(big());
    const times: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      const out = applyEdit(state, { type: 'setColumnHeader', index: 5, header: `Renamed ${i}` }, { merge: i > 0 });
      times.push(performance.now() - t0);
      if (!out.result.ok) throw new Error('refused');
      state = out.state;
    }
    times.sort((a, b) => a - b);
    const median = times[10]!;
    // eslint-disable-next-line no-console
    console.log(`[perf] one edit, 60 columns + 20 tables x 500 rows: median ${median.toFixed(1)} ms, max ${times[19]!.toFixed(1)} ms`);
    expect(median).toBeLessThan(100);
  });
});
