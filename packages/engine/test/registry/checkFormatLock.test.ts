// SPEC 8.12 "The format lock": every conversion attached to a format must reproduce
// its output (minus columns[].from), its sort/group (normalized to output headers) and
// its output validations.
import { describe, expect, it } from 'vitest';
import type { LearnResult } from '@formatai/shared';
import { checkFormatLock } from '../../src/registry/checkFormatLock';
import { formatOf } from '../../src/registry/formatOf';

function makeRules(overrides: Partial<LearnResult> = {}): LearnResult {
  return {
    schemaVersion: 1,
    input: {
      sheet: { pick: 'first' },
      headerRow: 'auto',
      columns: [
        { id: 'name', header: 'Name', type: 'text' },
        { id: 'amount', header: 'Amount', type: 'decimal' },
      ],
    },
    transform: { computed: [], valueMaps: [], sort: [] },
    output: {
      sheetName: 'Out',
      direction: 'ltr',
      language: 'en',
      titleRows: [],
      columns: [
        { header: 'Amount', from: 'amount', format: '#,##0.00' },
        { header: 'Name', from: 'name' },
      ],
    },
    validations: [],
    unsupported: [],
    assumptions: [],
    ...overrides,
  };
}

const format = formatOf(makeRules());

describe('checkFormatLock: two conversions of the same format', () => {
  it('pass when output/sort/group/validations agree, even with entirely different ids', () => {
    const otherConversion = makeRules({
      input: {
        sheet: { pick: 'name', name: 'Sheet2' },
        headerRow: 0,
        columns: [
          { id: 'nm', header: 'Full Name', type: 'text' },
          { id: 'amt', header: 'Total', type: 'decimal', padLeft: 3 },
        ],
      },
      output: {
        sheetName: 'Out',
        direction: 'ltr',
        language: 'en',
        titleRows: [],
        columns: [
          { header: 'Amount', from: 'amt', format: '#,##0.00' },
          { header: 'Name', from: 'nm' },
        ],
      },
    });
    expect(checkFormatLock(otherConversion, format)).toEqual([]);
  });

  it('the original conversion trivially passes its own format', () => {
    expect(checkFormatLock(makeRules(), format)).toEqual([]);
  });
});

describe('checkFormatLock: each kind of mismatch is reported', () => {
  it('header', () => {
    const rules = makeRules({
      output: {
        sheetName: 'Out',
        direction: 'ltr',
        language: 'en',
        titleRows: [],
        columns: [
          { header: 'Amount', from: 'amount', format: '#,##0.00' },
          { header: 'Full Name', from: 'name' },
        ],
      },
    });
    const problems = checkFormatLock(rules, format);
    expect(problems).toContainEqual(expect.objectContaining({ kind: 'formatMismatch', path: 'output.columns[1].header' }));
  });

  it('format', () => {
    const rules = makeRules({
      output: {
        sheetName: 'Out',
        direction: 'ltr',
        language: 'en',
        titleRows: [],
        columns: [
          { header: 'Amount', from: 'amount', format: '0.00' },
          { header: 'Name', from: 'name' },
        ],
      },
    });
    const problems = checkFormatLock(rules, format);
    expect(problems).toContainEqual(expect.objectContaining({ kind: 'formatMismatch', path: 'output.columns[0].format' }));
  });

  it('width', () => {
    const rules = makeRules({
      output: {
        sheetName: 'Out',
        direction: 'ltr',
        language: 'en',
        titleRows: [],
        columns: [
          { header: 'Amount', from: 'amount', format: '#,##0.00', width: 15 },
          { header: 'Name', from: 'name' },
        ],
      },
    });
    const problems = checkFormatLock(rules, format);
    expect(problems).toContainEqual(expect.objectContaining({ kind: 'formatMismatch', path: 'output.columns[0].width' }));
  });

  it('order', () => {
    const rules = makeRules({
      output: {
        sheetName: 'Out',
        direction: 'ltr',
        language: 'en',
        titleRows: [],
        columns: [
          { header: 'Name', from: 'name' },
          { header: 'Amount', from: 'amount', format: '#,##0.00' },
        ],
      },
    });
    const problems = checkFormatLock(rules, format);
    expect(problems.some((p) => p.path.startsWith('output.columns['))).toBe(true);
  });

  it('file', () => {
    const rules = makeRules({ output: { ...makeRules().output, file: { type: 'csv', delimiter: ',', header: true } } });
    const problems = checkFormatLock(rules, format);
    expect(problems).toContainEqual(expect.objectContaining({ kind: 'formatMismatch', path: 'output.file' }));
  });

  it('sort', () => {
    const rules = makeRules({ transform: { computed: [], valueMaps: [], sort: [{ column: 'amount', dir: 'desc' }] } });
    const problems = checkFormatLock(rules, format);
    expect(problems).toContainEqual(expect.objectContaining({ kind: 'formatMismatch', path: 'layout.sort[0]' }));
  });

  it('group', () => {
    const rules = makeRules({ transform: { computed: [], valueMaps: [], sort: [], group: { by: 'amount', showDetailRows: true } } });
    const problems = checkFormatLock(rules, format);
    expect(problems).toContainEqual(expect.objectContaining({ kind: 'formatMismatch', path: 'layout.group' }));
  });

  it('validation', () => {
    const rules = makeRules({ validations: [{ on: 'output', column: 'Amount', rule: 'range', min: 0, severity: 'flag' }] });
    const problems = checkFormatLock(rules, format);
    expect(problems).toContainEqual(expect.objectContaining({ kind: 'formatMismatch', path: 'validations' }));
  });
});
