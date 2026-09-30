// The registry's pure parts (no database): checking a rules file on its way in, shaping it for storage,
// the input signature, request-body validators, and the format-edit propagation (SPEC 8.12).
import { checkFormatLock, formatOf } from '@formatai/engine';
import { limits, tiers, type Rules } from '@formatai/shared';
import { describe, expect, it } from 'vitest';
import {
  nameKey,
  parseAlias,
  parseName,
  parseRun,
  parseSaveFields,
  parseUpdateFields,
} from '../../src/registry/bodies.js';
import { applyFormat, headerRenames } from '../../src/registry/propagate.js';
import { checkRulesFile, signatureOf, withMeta, type SaveMeta } from '../../src/registry/rules.js';
import { edited, saveBody, sourceOne, sourceTwo } from './helpers.js';

const meta: SaveMeta = {
  name: 'Catalog load',
  formatId: 'f1',
  sourceName: 'Source 1',
  status: 'verified',
  source: 'examplePair',
  learnPath: 'llm',
  masking: false,
  now: new Date('2026-09-30T12:00:00.000Z'),
};

function asRules(learn = sourceOne(), over: Partial<SaveMeta> = {}): Rules {
  const checked = checkRulesFile(withMeta(learn, { ...meta, ...over }), 'registered');
  if (!checked.ok) throw new Error(`fixture rules do not pass: ${JSON.stringify(checked.problems)}`);
  return checked.rules;
}

describe('withMeta', () => {
  it('turns a bare learn result into a rules file with server-set name and meta', () => {
    const rules = withMeta(sourceOne(), meta) as Rules;
    expect(rules.name).toBe('Catalog load');
    expect(rules.meta).toEqual({
      formatId: 'f1',
      sourceName: 'Source 1',
      source: 'examplePair',
      status: 'verified',
      learnPath: 'llm',
      masking: false,
      createdAt: '2026-09-30T12:00:00.000Z',
    });
  });

  it('overrides what the client sent for the fields the server owns, and keeps the rules\' own name and creation time', () => {
    const rules = withMeta(
      { ...sourceOne(), name: 'My name', meta: { formatId: 'stale', sourceName: 'x', source: 'descriptionOnly', status: 'draft', createdAt: '2020-01-01T00:00:00.000Z', model: 'old' } },
      { ...meta, model: 'm2' },
    ) as Rules;
    expect(rules.name).toBe('My name');
    expect(rules.meta).toMatchObject({ formatId: 'f1', sourceName: 'Source 1', source: 'examplePair', status: 'verified', createdAt: '2020-01-01T00:00:00.000Z', model: 'm2' });
  });

  it('leaves a value that is not an object for the schema check to reject', () => {
    expect(withMeta('x', meta)).toBe('x');
    expect(withMeta([1], meta)).toEqual([1]);
  });
});

describe('checkRulesFile (SPEC 9.2 layers 1-4 on save)', () => {
  it('accepts valid rules', () => {
    expect(checkRulesFile(withMeta(sourceOne(), meta), 'registered').ok).toBe(true);
  });

  it('reports structure problems as schema problems', () => {
    const res = checkRulesFile({ schemaVersion: 1 }, 'registered');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.onlyRuleLimit).toBe(false);
      expect(res.problems.length).toBeGreaterThan(0);
      expect(res.problems.every((p) => p.kind === 'schema')).toBe(true);
    }
  });

  it('reports dangling references and type errors', () => {
    const dangling = edited(sourceOne(), (r) => {
      r.output.columns[1]!.from = 'nope';
    });
    const ref = checkRulesFile(withMeta(dangling, meta), 'registered');
    expect(!ref.ok && ref.problems.some((p) => p.kind === 'reference')).toBe(true);

    const badType = edited(sourceOne(), (r) => {
      r.transform.computed[0]!.expr = { op: 'mul', args: [{ col: 'id' }, { const: 2 }] } as never; // ID x 2: text in arithmetic
    });
    const typed = checkRulesFile(withMeta(badType, meta), 'registered');
    expect(!typed.ok && typed.problems.some((p) => p.kind === 'type')).toBe(true);
  });

  it('tells the tier\'s rules-per-format count apart from every other problem', () => {
    const wide = (n: number) =>
      edited(sourceOne(), (r) => {
        r.output.columns = Array.from({ length: n }, (_, i) => ({ header: `C${i}`, from: 'id' }));
      });
    const over = tiers.registered.rulesPerFormat + 1;
    const res = checkRulesFile(withMeta(wide(over), meta), 'registered');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.onlyRuleLimit).toBe(true);
      expect(res.problems).toEqual([]);
    }
    // The paid tier has room for the same rules.
    expect(checkRulesFile(withMeta(wide(over), meta), 'paid').ok).toBe(true);
    // Over the limit AND broken: the problems come back, not the limit.
    const both = wide(over);
    both.output.columns[0]!.from = 'nope';
    const mixed = checkRulesFile(withMeta(both, meta), 'registered');
    expect(!mixed.ok && !mixed.onlyRuleLimit && mixed.problems.length > 0).toBe(true);
  });
});

describe('signatureOf (SPEC 8.12 input signature)', () => {
  it('lists the input columns with their aliases, types and whether they are required', () => {
    const rules = asRules(
      edited(sourceOne(), (r) => {
        r.input.columns[0]!.required = true;
        r.input.columns[1]!.aliases = ['Sum', 'Value'];
      }),
    );
    expect(signatureOf(rules)).toEqual({
      columns: [
        { header: 'ID', aliases: [], type: 'idLike', required: true },
        { header: 'Amount', aliases: ['Sum', 'Value'], type: 'decimal', required: false },
      ],
    });
  });
});

describe('request-body validators', () => {
  it('parseName trims, and bounds the length', () => {
    expect(parseName('  Supplier A ')).toBe('Supplier A');
    expect(parseName('')).toBeNull();
    expect(parseName('   ')).toBeNull();
    expect(parseName('x'.repeat(limits.registry.maxNameChars))).not.toBeNull();
    expect(parseName('x'.repeat(limits.registry.maxNameChars + 1))).toBeNull();
    expect(parseName('a\u0000b')).toBeNull();
    expect(parseName(5)).toBeNull();
    expect(parseName('ספק א')).toBe('ספק א');
  });

  it('nameKey compares names without case and extra spaces', () => {
    expect(nameKey('  Source   2 ')).toBe(nameKey('source 2'));
    expect(nameKey('Source 2')).not.toBe(nameKey('Source 3'));
  });

  it('parseSaveFields fills defaults, sorts the exceptions and drops counts that do not belong to the status', () => {
    const fields = parseSaveFields(saveBody({}, { status: 'verified', acceptedDifferences: 4, exampleExceptions: [9, 1, 9] }))!;
    expect(fields).toMatchObject({ status: 'verified', acceptedDifferences: 0, exampleExceptions: [1, 9], source: 'examplePair', learnPath: 'llm', masking: false });
    const accepted = parseSaveFields(saveBody({}, { status: 'differencesAccepted', acceptedDifferences: 4 }))!;
    expect(accepted.acceptedDifferences).toBe(4);
    expect(parseSaveFields(saveBody({}, { status: 'needsReview' }))).toBeNull();
    expect(parseSaveFields(saveBody({}, { model: '' }))).toBeNull();
    expect(parseSaveFields(saveBody({}, { source: 'telepathy' }))).toBeNull();
    expect(parseSaveFields(saveBody({}, { exampleExceptions: new Array(limits.registry.maxExampleExceptions + 1).fill(1) }))).toBeNull();
  });

  it('parseUpdateFields takes a rename, a rules save or both - and a status only with rules', () => {
    expect(parseUpdateFields({ sourceName: 'A' })).toEqual({ sourceName: 'A' });
    expect(parseUpdateFields({ rules: {}, status: 'verified' })?.save?.status).toBe('verified');
    expect(parseUpdateFields({ rules: {}, status: 'verified', sourceName: 'A', baseVersion: 3 })).toMatchObject({ sourceName: 'A', baseVersion: 3 });
    for (const bad of [{}, { status: 'verified' }, { rules: {} }, { rules: {}, status: 'needsReview' }, { sourceName: 'A', baseVersion: 0 }, { exampleExceptions: [1] }]) {
      expect(parseUpdateFields(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('parseRun and parseAlias', () => {
    expect(parseRun({ rows: 10, flagged: 0, fileName: 'x' })).toEqual({ rows: 10, flagged: 0 });
    expect(parseRun({ rows: -1, flagged: 0 })).toBeNull();
    expect(parseRun({ rows: 1 })).toBeNull();
    expect(parseAlias({ header: 'Amount', alias: ' Sum ' })).toEqual({ header: 'Amount', alias: 'Sum' });
    expect(parseAlias({ header: 'Amount', alias: '' })).toBeNull();
    expect(parseAlias({ header: '', alias: 'x' })).toBeNull();
    expect(parseAlias({ header: 'Amount', alias: 'x'.repeat(limits.registry.maxAliasChars + 1) })).toBeNull();
  });
});

describe('headerRenames', () => {
  it('finds a column that kept its source but changed its header', () => {
    const before = asRules();
    const after = edited(before, (r) => {
      r.output.columns[1]!.header = 'Grand total';
    });
    expect([...headerRenames(before, after)]).toEqual([['Grand total', 'Total']]);
  });

  it('finds nothing for an added, removed or reordered column', () => {
    const before = asRules();
    expect(headerRenames(before, edited(before, (r) => r.output.columns.reverse())).size).toBe(0);
    expect(headerRenames(before, edited(before, (r) => r.output.columns.push({ header: 'New', from: null }))).size).toBe(0);
    expect(headerRenames(before, edited(before, (r) => r.output.columns.pop())).size).toBe(0);
  });

  it('matches two renames in a row to the two old columns in order, and never claims one old column twice', () => {
    const before = edited(asRules(), (r) => {
      r.output.columns = [
        { header: 'A', from: 'id' },
        { header: 'B', from: 'id' },
      ];
    });
    const after = edited(before, (r) => {
      r.output.columns[0]!.header = 'A2';
      r.output.columns[1]!.header = 'B2';
    });
    expect([...headerRenames(before, after)]).toEqual([['A2', 'A'], ['B2', 'B']]);
  });
});

describe('applyFormat (SPEC 8.12 "Editing a format")', () => {
  const s1 = () => asRules(sourceOne());
  const s2 = () => asRules(sourceTwo(), { sourceName: 'Source 2' });

  it('gives another source the new output side with its own mappings, and passes the lock', () => {
    const edit = edited(s1(), (r) => {
      r.output.columns[1]!.header = 'Grand total';
      r.output.columns[1]!.width = 14;
      r.output.sheetName = 'Catalog';
    });
    const result = applyFormat(s2(), formatOf(edit), headerRenames(s1(), edit));
    expect(result.needsReview).toBe(false);
    expect(result.problems).toEqual([]);
    expect(result.rules.output.columns).toEqual([
      { header: 'ID', from: 'code' },
      { header: 'Grand total', from: 'cost', width: 14 },
    ]);
    expect(result.rules.output.sheetName).toBe('Catalog');
    expect(checkFormatLock(result.rules, formatOf(edit))).toEqual([]);
    // The source's own side is untouched.
    expect(result.rules.input).toEqual(s2().input);
    expect(result.rules.transform.computed).toEqual(s2().transform.computed);
  });

  it('does not mutate what it is given', () => {
    const target = s2();
    const snapshot = structuredClone(target);
    const edit = edited(s1(), (r) => {
      r.output.columns.reverse();
    });
    applyFormat(target, formatOf(edit), new Map());
    expect(target).toEqual(snapshot);
  });

  it('follows a reorder', () => {
    const edit = edited(s1(), (r) => r.output.columns.reverse());
    const result = applyFormat(s2(), formatOf(edit), new Map());
    expect(result.rules.output.columns.map((c) => [c.header, c.from])).toEqual([['Total', 'cost'], ['ID', 'code']]);
    expect(result.needsReview).toBe(false);
  });

  it('turns a dropped column into nothing and a gained one into an unsupported column that needs review', () => {
    const dropped = edited(s1(), (r) => r.output.columns.pop());
    const a = applyFormat(s2(), formatOf(dropped), new Map());
    expect(a.rules.output.columns).toEqual([{ header: 'ID', from: 'code' }]);
    expect(a.needsReview).toBe(false);

    const gained = edited(s1(), (r) => {
      r.output.columns.push({ header: 'Note', from: null });
      r.unsupported.push({ outputColumn: 'Note', reasonCode: 'other' });
    });
    const b = applyFormat(s2(), formatOf(gained), new Map());
    expect(b.needsReview).toBe(true);
    expect(b.newColumns).toEqual(['Note']);
    expect(b.rules.output.columns[2]).toEqual({ header: 'Note', from: null });
    expect(b.rules.unsupported).toEqual([{ outputColumn: 'Note', reasonCode: 'other' }]);
  });

  it('keeps and renames what the source said about its own unsupported columns and assumptions', () => {
    const target = edited(s2(), (r) => {
      r.output.columns.push({ header: 'Region', from: null });
      r.unsupported.push({ outputColumn: 'Region', reasonCode: 'externalData' });
      r.assumptions.push({ outputColumn: 'Total', reasonCode: 'roundingGuessed' }, { reasonCode: 'other' });
    });
    const source = edited(s1(), (r) => {
      r.output.columns.push({ header: 'Region', from: null });
      r.unsupported.push({ outputColumn: 'Region', reasonCode: 'externalData' });
    });
    const edit = edited(source, (r) => {
      r.output.columns[1]!.header = 'Grand total';
      r.output.columns[2]!.header = 'Area';
    });
    const result = applyFormat(target, formatOf(edit), headerRenames(source, edit));
    expect(result.rules.unsupported).toEqual([{ outputColumn: 'Area', reasonCode: 'externalData' }]);
    expect(result.rules.assumptions).toEqual([{ outputColumn: 'Grand total', reasonCode: 'roundingGuessed' }, { reasonCode: 'other' }]);
    expect(result.needsReview).toBe(false);
  });

  it('drops the deprecated id-based grandTotal and subtotal in favour of the format\'s header-keyed summary rows', () => {
    const target = edited(s2(), (r) => {
      (r.output as { grandTotal?: unknown }).grandTotal = { labelColumn: 'code', label: 'Sum', sum: ['cost'] };
      r.transform.group = { by: 'code', showDetailRows: true, subtotal: { labelColumn: 'code', label: 'Sub', sum: ['cost'] } } as never;
    });
    const edit = edited(s1(), (r) => {
      r.output.summaryRows = [{ label: 'All', labelColumn: 'ID', cells: { Total: 'sum' } }];
    });
    const result = applyFormat(target, formatOf(edit), new Map());
    expect((result.rules.output as { grandTotal?: unknown }).grandTotal).toBeUndefined();
    expect(result.rules.output.summaryRows).toEqual([{ label: 'All', labelColumn: 'ID', cells: { Total: 'sum' } }]);
    expect(result.rules.transform.group).toBeUndefined();
    expect(result.needsReview).toBe(false);
  });

  it('flags a title-row aggregate over an id the source does not have', () => {
    const edit = edited(s1(), (r) => {
      r.output.titleRows = [{ parts: [{ agg: 'min', column: 'amount', format: '0' }] }];
    });
    const result = applyFormat(s2(), formatOf(edit), new Map());
    expect(result.needsReview).toBe(true);
    expect(result.problems.some((p) => p.kind === 'reference')).toBe(true);
  });

  it('replaces the format\'s output validations and keeps the source\'s input ones', () => {
    const target = edited(s2(), (r) => {
      r.validations = [
        { column: 'code', rule: 'required', severity: 'flag' },
        { on: 'output', column: 'Total', rule: 'range', max: 1, severity: 'flag' },
      ];
    });
    const edit = edited(s1(), (r) => {
      r.validations = [{ on: 'output', column: 'ID', rule: 'unique', severity: 'block' }];
    });
    const result = applyFormat(target, formatOf(edit), new Map());
    expect(result.rules.validations).toEqual([
      { column: 'code', rule: 'required', severity: 'flag' },
      { on: 'output', column: 'ID', rule: 'unique', severity: 'block' },
    ]);
  });
});
