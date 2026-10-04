// Masking (SPEC 7.2, learning-loop proposal 7.5): dates are sent real - a TEXT cell that reads as a date too ("12 במרץ 2026",
// "2026-03-07", "05/03/2026", an impossible "31/02/2026") - and so are month and weekday names and the placeholders that mean
// "no value" ("N/A", "-", "לא ידוע"). They are vocabulary, not personal data. Everything else in a text cell is masked as before:
// the names stay hidden. Walked over the two stress cases where masking used to hide what the AI step needed to see: the payload
// with masking on carries those columns exactly as the payload with masking off does.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { learnFromExamples, type LearnCallResult } from '@formatai/engine';
import type { LearnPayload, PayloadCell } from '@formatai/shared';
import { loadCase, type CaseDef } from '../lib/caseLoader';

const CASES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cases');

/** The first payload of a learn (the answer is no rules: nothing else is needed). */
async function firstPayload(c: CaseDef, masking: boolean): Promise<LearnPayload> {
  let sent: LearnPayload | undefined;
  await learnFromExamples({
    input: { bytes: c.input.bytes, name: c.input.fileName },
    output: { bytes: c.output.bytes, name: c.output.fileName },
    masking,
    ...(masking ? { key: new TextEncoder().encode(`vocabulary:${c.name}`) } : {}),
    tier: 'paid',
    callLearn: async (payload): Promise<LearnCallResult> => {
      sent = payload;
      return { rules: null, problems: [], calls: [] };
    },
  });
  if (!sent) throw new Error(`${c.name}: no AI step was asked`);
  return sent;
}

/** The input cells of one column (by header), as the payload's samples carry them. */
function sentColumn(payload: LearnPayload, header: RegExp): PayloadCell[] {
  const column = payload.input.columns.findIndex((col) => header.test(col.header));
  if (column < 0) throw new Error(`no column ${String(header)}`);
  return payload.samples.flatMap((s) => (Array.isArray(s.in) ? [(s.in as PayloadCell[])[column] ?? null] : []));
}

describe('masking sends dates, month names and "no value" placeholders as they are', () => {
  it('dates-mixed-formats: the text Date column reaches the payload readable', async () => {
    const c = loadCase(path.join(CASES, 'dates-mixed-formats'))!;
    const [masked, plain] = [await firstPayload(c, true), await firstPayload(c, false)];
    const dates = sentColumn(masked, /^date$/i);
    expect(dates).toEqual(sentColumn(plain, /^date$/i));
    // every reading is there: day/month text, ISO text and the Hebrew month-name form
    expect(dates.some((d) => typeof d === 'string' && /במרץ/.test(d))).toBe(true);
    expect(dates.some((d) => typeof d === 'string' && /^\d{2}\/\d{2}\/\d{4}$/.test(d))).toBe(true);
    // the customers are still masked
    const customers = sentColumn(masked, /customer/i);
    expect(customers).not.toEqual(sentColumn(plain, /customer/i));
  });

  it('broken-values: "N/A" and the text dates are sent real, the customer names stay masked', async () => {
    const c = loadCase(path.join(CASES, 'broken-values'))!;
    const [masked, plain] = [await firstPayload(c, true), await firstPayload(c, false)];
    for (const header of [/amount/i, /date/i]) expect(sentColumn(masked, header)).toEqual(sentColumn(plain, header));
    const sent = [...sentColumn(masked, /amount/i), ...sentColumn(masked, /date/i)];
    expect(sent).toContain('N/A');
    expect(sent).toContain('31/02/2026');

    // no customer name, nor any word of one, is in the request
    const json = JSON.stringify(masked);
    const names = sentColumn(plain, /customer/i).filter((v): v is string => typeof v === 'string');
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) for (const word of name.trim().split(/\s+/)) if (word.length >= 4) expect(json).not.toContain(word);
  });
});
