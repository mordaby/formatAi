// The learning loop's size rules, shared by the browser's loop and the server's check of a round (SPEC 9.3): the payload as the server
// checks it (the samples plus every row sent), the rows one learn may send, and the byte cap.
import { describe, expect, it } from 'vitest';
import { limits, loopRowsFit, LoopRowsSchema, payloadBytes, payloadRowCount, withRows, type LearnPayload, type Sample } from '../src';

function payload(samples: number, dropped = 0): LearnPayload {
  return {
    masking: true,
    input: { sheetName: 'In', direction: 'ltr', layout: { headerRow: 0, rowsAbove: 0, footerFirstCell: [] }, columns: [{ i: 0, header: 'A', type: 'text' }] },
    output: {
      file: { type: 'xlsx' },
      layout: { sheetName: 'Out', direction: 'ltr', language: 'en', titleRows: [], headerRow: 0, headerBold: false, summary: false, groupBy: null, summaryRows: [], sort: null },
      columns: [{ i: 0, header: 'A', type: 'text' }],
    },
    samples: Array.from({ length: samples }, (_, i) => ({ in: [`s${i}`], out: [`s${i}`] })),
    ...(dropped > 0 ? { dropped: Array.from({ length: dropped }, (_, i) => [`d${i}`]) } : {}),
    hints: [],
  };
}

const rows = (n: number): Sample[] => Array.from({ length: n }, (_, i) => ({ in: [`r${i}`], out: [`r${i}`] }));

describe('the loop rows', () => {
  it('withRows adds the rows to the samples, in order; payloadRowCount counts samples and dropped rows', () => {
    const p = payload(2, 1);
    expect(withRows(p, rows(2)).samples.map((s) => s.in[0])).toEqual(['s0', 's1', 'r0', 'r1']);
    expect(payloadRowCount(p)).toBe(3);
  });

  it('fit: at most 40 masked rows in one learn, the payload\'s own included', () => {
    const max = limits.learn.loop.maxRowsTotal;
    expect(loopRowsFit(payload(12, 5), rows(max - 17))).toBe(true);
    expect(loopRowsFit(payload(12, 5), rows(max - 16))).toBe(false);
  });

  it('fit: the payload with every row added stays under the byte cap', () => {
    const p = payload(1);
    const big: Sample[] = [{ in: ['x'.repeat(limits.payload.maxBytes)], out: ['y'] }];
    expect(payloadBytes(withRows(p, big))).toBeGreaterThan(limits.payload.maxBytes);
    expect(loopRowsFit(p, big)).toBe(false);
  });

  it('the schema takes sample-shaped rows (a dropped row has no output rows) and no more than a learn may send', () => {
    expect(LoopRowsSchema.safeParse([{ in: ['a'], out: ['b'] }, { in: ['c'], out: [] }]).success).toBe(true);
    expect(LoopRowsSchema.safeParse([{ in: 'a', out: [] }]).success).toBe(false);
    expect(LoopRowsSchema.safeParse(rows(limits.learn.loop.maxRowsTotal + 1)).success).toBe(false);
  });
});
