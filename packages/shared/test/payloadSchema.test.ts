// The learn payload's shape check (`LearnPayloadSchema`): what POST /api/learn, /step and /repair refuse before anything else runs.
import { describe, expect, it } from 'vitest';
import { LearnPayloadSchema, limits } from '../src';

function payload(inputColumns: { i: number; header: string; type: string }[], extra: Record<string, unknown> = {}): unknown {
  return {
    masking: true,
    input: { sheetName: 'S', direction: 'ltr', layout: {}, columns: inputColumns },
    output: { file: { type: 'xlsx' }, layout: {}, columns: [{ i: 0, header: 'Out', type: 'text' }] },
    samples: [{ in: ['a'], out: ['a'] }],
    hints: [],
    ...extra,
  };
}

describe('LearnPayloadSchema: column positions (API audit C3)', () => {
  it("accepts any position up to Excel's last column", () => {
    expect(limits.payload.maxColumnIndex).toBe(16_383);
    expect(LearnPayloadSchema.safeParse(payload([{ i: limits.payload.maxColumnIndex, header: 'A', type: 'text' }])).success).toBe(true);
  });

  it('refuses a position past it (it sized the sample table: 4.29e9 ran for minutes)', () => {
    expect(LearnPayloadSchema.safeParse(payload([{ i: limits.payload.maxColumnIndex + 1, header: 'A', type: 'text' }])).success).toBe(false);
    expect(LearnPayloadSchema.safeParse(payload([{ i: 4_294_967_295, header: 'A', type: 'text' }])).success).toBe(false);
  });

  it('refuses two columns at one position, on either side', () => {
    const twice = [
      { i: 1, header: 'A', type: 'text' },
      { i: 1, header: 'B', type: 'text' },
    ];
    expect(LearnPayloadSchema.safeParse(payload(twice)).success).toBe(false);
    const p = payload([{ i: 0, header: 'A', type: 'text' }]) as { output: { columns: unknown[] } };
    p.output.columns = twice;
    expect(LearnPayloadSchema.safeParse(p).success).toBe(false);
  });

  it('bounds the completion columns and the skipped columns the same way', () => {
    const one = [{ i: 0, header: 'A', type: 'text' }];
    expect(LearnPayloadSchema.safeParse(payload(one, { skipColumns: [limits.payload.maxColumnIndex + 1] })).success).toBe(false);
    expect(LearnPayloadSchema.safeParse(payload(one, { complete: { fixed: {}, columns: [limits.payload.maxColumnIndex + 1], parts: [] } })).success).toBe(false);
    expect(LearnPayloadSchema.safeParse(payload(one, { skipColumns: [0] })).success).toBe(true);
  });
});
