import type { VerifyResult } from '@formatai/engine';
import { assumptionMessages, unsupportedMessages, type LearnResult } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import { describeRules } from './describe';
import { col, lineTexts, num, rules } from './fixtures';
import type { Line, RulesMapModel, VerificationLike } from './types';

/** A small format with one line of every kind that can carry a status. */
function base(): LearnResult {
  return rules({
    input: { rowFilters: [{ column: 'c_status', op: 'ne', value: 'Discontinued' }] },
    transform: {
      computed: [{ id: 'p_price', type: 'decimal', expr: { op: 'round', digits: 2, arg: { op: 'mul', args: [col('c_cost'), num(1.18)] } } }],
      sort: [{ column: 'c_name', dir: 'asc' }],
    },
    output: {
      titleRows: [{ text: 'Report' }],
      columns: [
        { header: 'Name', from: 'c_name' },
        { header: 'Price', from: 'p_price' },
        { header: 'Fulfillment', from: null },
      ],
    },
  });
}

const find = (model: RulesMapModel, id: string): Line => {
  const found = model.sections.flatMap((s) => s.lines).find((l) => l.id === id);
  if (!found) throw new Error(`no line ${id}: ${JSON.stringify(lineTexts(model))}`);
  return found;
};

const verification = (patch: Partial<VerificationLike> = {}): VerificationLike => ({
  matched: 8,
  total: 10,
  mismatches: [],
  layoutProblems: [],
  ...patch,
});

describe('line status', () => {
  it('a line with nothing wrong matches the example', () => {
    const model = describeRules(base(), { lang: 'en' });
    expect(find(model, 'col:Name')).toMatchObject({ status: 'matches' });
    expect(find(model, 'col:Name').statusReason).toBeUndefined();
    expect(find(model, 'filter:0').status).toBe('matches');
  });

  it('takes a column from its mismatches in the verification', () => {
    const model = describeRules(base(), {
      lang: 'en',
      verification: verification({
        mismatches: [
          { exampleRow: 3, column: 'Price' },
          { exampleRow: 5, column: 'Price' },
          { exampleRow: 5, column: 'Name' },
        ],
      }),
    });
    expect(find(model, 'col:Price')).toMatchObject({ status: 'check', statusReason: 'Differs from your example in 2 of 10 rows.' });
    expect(find(model, 'col:Name')).toMatchObject({ status: 'check', statusReason: 'Differs from your example in 1 of 10 rows.' });
  });

  it('counts a row once per column, however many cells differ', () => {
    const model = describeRules(base(), {
      lang: 'en',
      verification: verification({ mismatches: [{ exampleRow: 3, column: 'Price' }, { exampleRow: 3, column: 'Price' }] }),
    });
    expect(find(model, 'col:Price').statusReason).toBe('Differs from your example in 1 of 10 rows.');
  });

  it('a column with no mismatches matches, even when others do not', () => {
    const model = describeRules(base(), { lang: 'en', verification: verification({ mismatches: [{ exampleRow: 3, column: 'Price' }] }) });
    expect(find(model, 'col:Name').status).toBe('matches');
  });

  it('says it in Hebrew too', () => {
    const model = describeRules(base(), { lang: 'he', verification: verification({ mismatches: [{ exampleRow: 3, column: 'Price' }] }) });
    expect(find(model, 'col:Price').statusReason).toBe('שונה מהדוגמה שלכם ב-1 מתוך 10 שורות.');
  });

  it('turns an assumption into "please check" with the plain-words message', () => {
    const rulesWith = { ...base(), assumptions: [{ outputColumn: 'Price', reasonCode: 'roundingGuessed' as const }] };
    const en = describeRules(rulesWith, { lang: 'en' });
    expect(find(en, 'col:Price')).toMatchObject({ status: 'check', statusReason: assumptionMessages.roundingGuessed.en });
    const he = describeRules(rulesWith, { lang: 'he' });
    expect(find(he, 'col:Price').statusReason).toBe(assumptionMessages.roundingGuessed.he);
  });

  it('treats a suspected overfit as "please check"', () => {
    const model = describeRules(base(), { lang: 'en', assumptions: [{ outputColumn: 'Name', reasonCode: 'overfitSuspected' }] });
    expect(find(model, 'col:Name')).toMatchObject({ status: 'check', statusReason: assumptionMessages.overfitSuspected.en });
  });

  it('puts a row-level assumption on the lines it is about', () => {
    const model = describeRules(base(), {
      lang: 'en',
      assumptions: [
        { reasonCode: 'filterGuessed' },
        { reasonCode: 'sortGuessed' },
        { reasonCode: 'titleGuessed' },
        { reasonCode: 'formatGuessed' },
      ],
    });
    expect(find(model, 'filter:0')).toMatchObject({ status: 'check', statusReason: assumptionMessages.filterGuessed.en });
    expect(find(model, 'sort').statusReason).toBe(assumptionMessages.sortGuessed.en);
    expect(find(model, 'title:0').statusReason).toBe(assumptionMessages.titleGuessed.en);
    expect(find(model, 'file').statusReason).toBe(assumptionMessages.formatGuessed.en);
    expect(find(model, 'col:Name').status).toBe('matches');
    expect(model.notes).toEqual([]);
  });

  it('keeps an assumption that has no line as a note', () => {
    const model = describeRules(base(), { lang: 'en', assumptions: [{ reasonCode: 'other' }, { outputColumn: 'Nope', reasonCode: 'rateGuessed' }] });
    expect(model.notes).toEqual([
      { kind: 'assumption', code: 'other', message: assumptionMessages.other.en },
      { kind: 'assumption', code: 'rateGuessed', column: 'Nope', message: assumptionMessages.rateGuessed.en },
    ]);
  });

  it('marks an unsupported column as needing input, with the shared message', () => {
    const model = describeRules(base(), { lang: 'en', unsupported: [{ outputColumn: 'Fulfillment', reasonCode: 'externalData' }] });
    expect(find(model, 'col:Fulfillment')).toMatchObject({ status: 'needsInput', statusReason: unsupportedMessages.externalData.en });
    const he = describeRules(base(), { lang: 'he', unsupported: [{ outputColumn: 'Fulfillment', reasonCode: 'hiddenByMasking' }] });
    expect(find(he, 'col:Fulfillment').statusReason).toBe(unsupportedMessages.hiddenByMasking.he);
  });

  it('a column with no source needs input even without an unsupported entry', () => {
    const model = describeRules(base(), { lang: 'en' });
    expect(find(model, 'col:Fulfillment')).toMatchObject({
      status: 'needsInput',
      statusReason: "Nothing fills this column yet. Choose how it's made.",
    });
  });

  it('reads unsupported and assumptions from the rules unless told otherwise', () => {
    const r = { ...base(), unsupported: [{ outputColumn: 'Fulfillment', reasonCode: 'pivot' as const }] };
    expect(find(describeRules(r, { lang: 'en' }), 'col:Fulfillment').statusReason).toBe(unsupportedMessages.pivot.en);
    expect(find(describeRules(r, { lang: 'en', unsupported: [{ outputColumn: 'Fulfillment', reasonCode: 'other' }] }), 'col:Fulfillment').statusReason).toBe(
      unsupportedMessages.other.en,
    );
  });

  it('"edited by you" wins over everything else', () => {
    const model = describeRules(base(), {
      lang: 'en',
      verification: verification({ mismatches: [{ exampleRow: 3, column: 'Price' }] }),
      assumptions: [{ outputColumn: 'Price', reasonCode: 'roundingGuessed' }],
      unsupported: [{ outputColumn: 'Fulfillment', reasonCode: 'externalData' }],
      edited: new Set(['col:Price', 'col:Fulfillment']),
    });
    expect(find(model, 'col:Price').status).toBe('edited');
    expect(find(model, 'col:Fulfillment').status).toBe('edited');
    expect(find(model, 'col:Name').status).toBe('matches');
  });

  it('flags the row-related lines when the row count differs', () => {
    const model = describeRules(base(), {
      lang: 'en',
      verification: verification({ layoutProblems: ['expected 10 data row(s) in the example output, the rules produce 9'] }),
    });
    expect(find(model, 'filter:0')).toMatchObject({ status: 'check', statusReason: "The number of rows doesn't match your example." });
    expect(find(model, 'col:Name').status).toBe('matches');
  });

  it('flags the layout lines a layout problem is about', () => {
    const model = describeRules(base(), {
      lang: 'en',
      verification: verification({ layoutProblems: ["the rules produce an extra title row the example output doesn't have"] }),
    });
    expect(find(model, 'title:0')).toMatchObject({ status: 'check', statusReason: "This part doesn't fully match your example." });
    expect(find(model, 'sort').status).toBe('matches');
    const file = describeRules(base(), {
      lang: 'en',
      verification: verification({ layoutProblems: ['output file settings do not match the example (expected {}, rules declare {})'] }),
    });
    expect(find(file, 'file').status).toBe('check');
  });

  it('warns about title, blank and summary rows in a text file', () => {
    const r = rules({ output: { file: { type: 'csv' }, titleRows: [{ text: 'Report' }], summaryRows: [{ label: 'Total', cells: { Name: 'count' } }] } });
    const model = describeRules(r, { lang: 'en' });
    expect(find(model, 'title:0')).toMatchObject({ status: 'check' });
    expect(find(model, 'title:0').statusReason).toMatch(/^Text files usually don't have title, blank or summary rows/);
    expect(find(model, 'summary:end:0').status).toBe('check');
    expect(find(model, 'col:Name').status).toBe('matches');
  });

  it('accepts the engine\'s VerifyResult as it is', () => {
    const result: VerifyResult = { verified: false, matched: 1, total: 2, mismatches: [{ exampleRow: 2, column: 'Price', expected: 1, actual: 2 }], layoutProblems: [], repairProblems: [] };
    const model = describeRules(base(), { lang: 'en', verification: result });
    expect(find(model, 'col:Price').status).toBe('check');
  });
});
