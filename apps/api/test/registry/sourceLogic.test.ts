// The pure half of sources (no database): merging a saved conversion into an existing source, writing a source's structure into
// a conversion, and choosing the source a file belongs to (SPEC 8.15).
import { checkSourceLock, sourceOf } from '@formatai/engine';
import type { LearnResult, Rules, SourceStructure } from '@formatai/shared';
import { ObjectId } from 'mongodb';
import { describe, expect, it } from 'vitest';
import type { SourceDoc } from '../../src/models.js';
import { checkRulesFile, withMeta } from '../../src/registry/rules.js';
import { applySource, mergeForReuse, mergeFromEdit, newIgnoredHeaders, pickReusableSource, unusedExampleHeaders, withDerivedRequired, withReadAsOf, withSourceAliases } from '../../src/registry/sourceLogic.js';
import { edited, sourceOne, sourceTwo } from './helpers.js';

function asRules(learn: LearnResult): Rules {
  const checked = checkRulesFile(
    withMeta(learn, { name: 'F', formatId: 'f1', sourceName: 'S', status: 'verified', source: 'examplePair', learnPath: 'llm', masking: false, now: new Date('2026-09-30T00:00:00Z') }),
    'registered',
  );
  if (!checked.ok) throw new Error(JSON.stringify(checked.problems));
  return checked.rules;
}

const one = (): Rules => asRules(sourceOne()); // ID (idLike), Amount (decimal)
const two = (): Rules => asRules(sourceTwo()); // Code (idLike), Price (decimal)

describe('mergeForReuse (saving a conversion into an existing source)', () => {
  const source: SourceStructure = sourceOf(one());

  it('merges nothing when the conversion is the source itself', () => {
    const r = mergeForReuse(source, one());
    expect(r).toMatchObject({ ok: true, changed: false });
  });

  it('adds columns and aliases the source did not have, and lets `required` accumulate', () => {
    const more = edited(one(), (r) => {
      r.input.columns[0]!.aliases = ['Identifier'];
      r.input.columns[1]!.required = true;
      r.input.columns.push({ id: 'note', header: 'Note', type: 'text' });
    });
    const r = mergeForReuse(source, more);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.changed).toBe(true);
    expect(r.structure.inputSignature.columns).toEqual([
      { header: 'ID', aliases: ['Identifier'], type: 'idLike', required: false },
      { header: 'Amount', aliases: [], type: 'decimal', required: true },
      { header: 'Note', aliases: [], type: 'text', required: false },
    ]);
    // the source itself was not touched
    expect(source.inputSignature.columns).toHaveLength(2);
  });

  it('finds a column the way the engine does (case, an alias): the conversion adopts the source’s header', () => {
    const shouting = edited(one(), (r) => {
      r.input.columns[0]!.header = 'id';
    });
    const r = mergeForReuse(source, shouting);
    expect(r).toMatchObject({ ok: true, changed: false });
    if (!r.ok) return;
    const applied = applySource(shouting, r.structure);
    expect(applied.rules.input.columns[0]!.header).toBe('ID');
    expect(applied.needsReview).toBe(false);
  });

  it('does not fit when a column is typed differently, or read another way (nothing is changed to make it fit)', () => {
    const typed = edited(one(), (r) => {
      r.input.columns[1]!.type = 'text';
    });
    const t = mergeForReuse(source, typed);
    expect(t.ok).toBe(false);
    if (!t.ok) expect(t.problems.map((p) => p.path)).toEqual(['input.columns[1].type']);

    const reading = edited(one(), (r) => {
      r.input.headerRow = 2;
      r.input.stopAt = { when: 'firstCellMatches', values: ['Total'] };
    });
    const g = mergeForReuse(source, reading);
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.problems.map((p) => p.path)).toEqual(['input.headerRow', 'input.stopAt']);

    // a check that leaves rows out must agree (a flag check need not: see below)
    const check = edited(one(), (r) => {
      r.validations.push({ column: 'amount', rule: 'range', min: 0, severity: 'block' });
    });
    const v = mergeForReuse(source, check);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.problems.map((p) => p.path)).toEqual(['validations']);
  });

  // SPEC 8.15 "The source lock": input checks are the source's per column; a conversion is held only to those on its columns.
  describe('input checks, per column', () => {
    const required = (column: string, severity: 'flag' | 'block' = 'flag') => ({ column, rule: 'required', severity }) as const;
    /** A source learned from a conversion that reads ID and Amount and carries a check on each. */
    const wide = (): SourceStructure => sourceOf(edited(one(), (r) => { r.validations = [required('id'), required('amount')]; }));
    const onlyId = (): Rules =>
      edited(one(), (r) => {
        r.input.columns = [r.input.columns[0]!];
        r.transform.computed = [];
        r.output.columns = [{ header: 'ID', from: 'id' }];
      });

    it('a conversion that reads fewer columns, so lacks the checks on the ones it does not read, fits and changes nothing', () => {
      const subset = edited(onlyId(), (r) => { r.validations = [required('id')]; });
      expect(mergeForReuse(wide(), subset)).toMatchObject({ ok: true, changed: false });
      expect(mergeForReuse(wide(), onlyId())).toMatchObject({ ok: true, changed: false });
    });

    it('DECISION: a flag check only the conversion has, on a column both read, is merged into the source (the union)', () => {
      const more = edited(one(), (r) => { r.validations = [required('id'), { column: 'amount', rule: 'range', min: 0, severity: 'flag' }]; });
      const r = mergeForReuse(wide(), more);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.changed).toBe(true);
      expect(r.structure.inputValidations).toEqual([required('ID'), required('Amount'), { column: 'Amount', rule: 'range', min: 0, severity: 'flag' }]);
      // the source itself was not touched, and the conversion still honours the lock of the merged source
      expect(wide().inputValidations).toHaveLength(2);
      expect(checkSourceLock(more, r.structure)).toEqual([]);
    });

    it('a flag check only the source has is not a mismatch: the source keeps it and nothing changes', () => {
      const lacking = edited(one(), (r) => { r.validations = [required('id')]; });
      const r = mergeForReuse(wide(), lacking);
      expect(r).toMatchObject({ ok: true, changed: false });
      if (r.ok) expect(r.structure.inputValidations).toEqual(wide().inputValidations);
    });

    it('a block check only one side has, on a column both read, does not fit', () => {
      const block = edited(one(), (r) => { r.validations = [required('id'), required('amount', 'block')]; });
      const a = mergeForReuse(wide(), block);
      expect(a.ok).toBe(false);
      if (!a.ok) expect(a.problems.map((p) => p.path)).toEqual(['validations']);
      const source = sourceOf(block);
      const b = mergeForReuse(source, edited(one(), (r) => { r.validations = [required('id')]; }));
      expect(b.ok).toBe(false);
      // ...but on a column the conversion doesn't read it is none of its business
      expect(mergeForReuse(source, onlyId())).toMatchObject({ ok: true, changed: false });
    });

    it('checks on a column only the conversion reads are added to the source, whatever their severity', () => {
      const withNote = edited(one(), (r) => {
        r.input.columns.push({ id: 'note', header: 'Note', type: 'text' });
        r.validations = [required('id'), required('note', 'block')];
      });
      const r = mergeForReuse(wide(), withNote);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.changed).toBe(true);
      expect(r.structure.inputSignature.columns.map((c) => c.header)).toEqual(['ID', 'Amount', 'Note']);
      expect(r.structure.inputValidations).toEqual([required('ID'), required('Amount'), required('Note', 'block')]);
      expect(checkSourceLock(withNote, r.structure)).toEqual([]);
    });

    it('finds the shared column the way the engine does: a header spelled another way is the same column', () => {
      const shouting = edited(one(), (r) => {
        r.input.columns[1]!.header = 'AMOUNT';
        r.validations = [required('id'), { column: 'amount', rule: 'range', min: 0, severity: 'flag' }];
      });
      const r = mergeForReuse(wide(), shouting);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.structure.inputValidations.at(-1)).toEqual({ column: 'Amount', rule: 'range', min: 0, severity: 'flag' });
    });
  });
});

describe('applySource (a source edit reaches a conversion)', () => {
  it('rewrites headers, aliases, types, reading options and input checks - and keeps ids, required, transform, output', () => {
    const rules = one();
    const s: SourceStructure = {
      inputSignature: {
        columns: [
          { header: 'Item', aliases: ['ID', 'Code'], type: 'text', required: false },
          { header: 'Amount', aliases: [], type: 'decimal', required: false },
        ],
      },
      inputReading: { sheet: { pick: 'name', name: 'Data' }, headerRow: 1 },
      inputValidations: [{ column: 'Item', rule: 'required', severity: 'flag' }],
    };
    const applied = applySource(rules, s, new Map([['ID', 'Item']]));
    expect(applied.changed).toBe(true);
    expect(applied.needsReview).toBe(false);
    const r = applied.rules;
    expect(r.input.columns[0]).toEqual({ id: 'id', header: 'Item', aliases: ['ID', 'Code'], type: 'text' });
    expect(r.input.sheet).toEqual({ pick: 'name', name: 'Data' });
    expect(r.input.headerRow).toBe(1);
    expect(r.validations).toEqual([{ column: 'id', rule: 'required', severity: 'flag' }]);
    // what the rules DO with the columns is untouched
    expect(r.transform).toEqual(rules.transform);
    expect(r.output).toEqual(rules.output);
    expect(checkSourceLock(r, s)).toEqual([]);
    // the original is not mutated
    expect(rules.input.columns[0]!.header).toBe('ID');
  });

  it('a column the source no longer has is dropped, and what still reads it makes the conversion need review', () => {
    const s = sourceOf(one());
    s.inputSignature.columns = s.inputSignature.columns.filter((c) => c.header !== 'Amount');
    const applied = applySource(one(), s);
    expect(applied.rules.input.columns.map((c) => c.header)).toEqual(['ID']);
    expect(applied.needsReview).toBe(true);
    expect(applied.problems.length).toBeGreaterThan(0);
  });

  it("DECISION: gives a conversion only the source's input checks on the columns IT declares (another column's would refer to one the rules lack)", () => {
    const source: SourceStructure = {
      ...sourceOf(one()),
      inputValidations: [
        { column: 'ID', rule: 'required', severity: 'flag' },
        { column: 'Amount', rule: 'range', min: 0, severity: 'block' },
      ],
    };
    const onlyId = edited(one(), (r) => {
      r.input.columns = [r.input.columns[0]!];
      r.transform.computed = [];
      r.output.columns = [{ header: 'ID', from: 'id' }];
    });
    const applied = applySource(onlyId, source);
    expect(applied.needsReview).toBe(false);
    expect(applied.rules.validations).toEqual([{ column: 'id', rule: 'required', severity: 'flag' }]);
    expect(checkSourceLock(applied.rules, source)).toEqual([]);
    // the one that reads both gets both, turned back into its own ids
    expect(applySource(one(), source).rules.validations).toEqual([
      { column: 'id', rule: 'required', severity: 'flag' },
      { column: 'amount', rule: 'range', min: 0, severity: 'block' },
    ]);
  });

  it("a flag check another conversion brought to a shared column comes along; the conversion's output validations stay", () => {
    const source: SourceStructure = { ...sourceOf(one()), inputValidations: [{ column: 'Amount', rule: 'range', min: 0, severity: 'flag' }] };
    const target = edited(one(), (r) => { r.validations = [{ on: 'output', column: 'Total', rule: 'unique', severity: 'flag' }]; });
    const applied = applySource(target, source);
    expect(applied.rules.validations).toEqual([
      { column: 'amount', rule: 'range', min: 0, severity: 'flag' },
      { on: 'output', column: 'Total', rule: 'unique', severity: 'flag' },
    ]);
    expect(applied.needsReview).toBe(false);
  });

  it("DECISION: a cut-off check (cutoffRange) is the conversion's own: never in the source, kept as it is when the source is written back", () => {
    const cutoff = { column: 'amount', rule: 'cutoffRange', low: 100, high: 200, value: 150, includes: 'high', severity: 'flag' } as const;
    const target = edited(one(), (r) => { r.validations = [...r.validations, cutoff]; });
    const source = sourceOf(target);
    expect(source.inputValidations.some((v) => v.rule === 'cutoffRange')).toBe(false);
    const applied = applySource(target, source);
    expect(applied.rules.validations).toContainEqual(cutoff);
    expect(applied.needsReview).toBe(false);
    expect(checkSourceLock(applied.rules, source)).toEqual([]);
  });

  it("a check on no column of the source (a computed column's) is written as it is", () => {
    const check = { column: 'total', rule: 'range', min: 0, severity: 'flag' } as const;
    const source: SourceStructure = { ...sourceOf(one()), inputValidations: [check] };
    expect(applySource(edited(one(), (r) => { r.validations = [check]; }), source).rules.validations).toEqual([check]);
  });

  it('is a no-op for a conversion already as the source says', () => {
    const applied = applySource(one(), sourceOf(one()));
    expect(applied).toMatchObject({ changed: false, needsReview: false, problems: [] });
  });
});

describe('readAs (SPEC 8.4a): what a column reads another way belongs to the source', () => {
  const withMap = (map: Record<string, string> | undefined): Rules => edited(one(), (r) => void (r.input.columns[1]!.readAs = map));

  it('applySource writes the source column’s readAs into the conversion (and takes it away when the source has none)', () => {
    const source = sourceOf(withMap({ 'N/A': '', none: '0' }));
    const applied = applySource(one(), source);
    expect(applied.rules.input.columns[1]!.readAs).toEqual({ 'N/A': '', none: '0' });
    expect(applied).toMatchObject({ changed: true, needsReview: false, problems: [] });
    // a copy: changing the conversion's does not change the source's
    applied.rules.input.columns[1]!.readAs!['x'] = 'y';
    expect(source.inputSignature.columns[1]!.readAs).toEqual({ 'N/A': '', none: '0' });
    const cleared = applySource(withMap({ 'N/A': '' }), sourceOf(one()));
    expect('readAs' in cleared.rules.input.columns[1]!).toBe(false);
    expect(cleared.needsReview).toBe(false);
  });

  it('mergeForReuse: a conversion without the mapping fits a source that has it, and the source keeps it', () => {
    const source = sourceOf(withMap({ 'N/A': '' }));
    const r = mergeForReuse(source, one());
    expect(r).toMatchObject({ ok: true, changed: false });
    if (!r.ok) return;
    expect(r.structure.inputSignature.columns[1]!.readAs).toEqual({ 'N/A': '' });
    // ...and applying it brings the conversion to the source (so it passes the source lock afterwards)
    const applied = applySource(one(), r.structure);
    expect(applied.rules.input.columns[1]!.readAs).toEqual({ 'N/A': '' });
    expect(checkSourceLock(applied.rules, r.structure)).toEqual([]);
  });

  it('mergeForReuse: a mapping only the conversion has is added to the source (the union); one that says another value does not fit', () => {
    const source = sourceOf(withMap({ 'N/A': '' }));
    const more = mergeForReuse(source, withMap({ none: '0' }));
    expect(more).toMatchObject({ ok: true, changed: true });
    if (more.ok) expect(more.structure.inputSignature.columns[1]!.readAs).toEqual({ 'N/A': '', none: '0' });
    const clash = mergeForReuse(source, withMap({ 'N/A': '0' }));
    expect(clash.ok).toBe(false);
    if (!clash.ok) expect(clash.problems.map((p) => p.path)).toEqual(['input.columns[1].readAs']);
  });

  it('mergeFromEdit: the editing conversion’s readAs IS the source’s afterwards (set, changed or taken away)', () => {
    const before = withMap({ 'N/A': '' });
    const source = sourceOf(before);
    const added = mergeFromEdit(source, edited(before, (r) => void (r.input.columns[1]!.readAs = { 'N/A': '', none: '0' })), before);
    expect(added.structure.inputSignature.columns[1]!.readAs).toEqual({ 'N/A': '', none: '0' });
    const away = mergeFromEdit(source, one(), before);
    expect('readAs' in away.structure.inputSignature.columns[1]!).toBe(false);
  });

  it('withReadAsOf: only the readAs of the columns the rules declare change - a restored version undoes a mapping, nothing else is touched', () => {
    const source: SourceStructure = {
      ...sourceOf(withMap({ 'N/A': '' })),
      inputValidations: [{ column: 'Amount', rule: 'required', severity: 'flag' }],
    };
    source.inputSignature.columns.push({ header: 'Note', aliases: ['Remark'], type: 'text', required: false, readAs: { x: 'y' } });
    const back = withReadAsOf(source, one());
    expect(back.inputSignature.columns.map((c) => [c.header, c.readAs])).toEqual([
      ['ID', undefined],
      ['Amount', undefined],
      ['Note', { x: 'y' }], // a column the restored version does not declare is the source's own business
    ]);
    expect(back.inputValidations).toEqual(source.inputValidations);
    expect(source.inputSignature.columns[1]!.readAs).toEqual({ 'N/A': '' }); // the argument is not mutated
    const set = withReadAsOf(sourceOf(one()), withMap({ a: 'b' }));
    expect(set.inputSignature.columns[1]!.readAs).toEqual({ a: 'b' });
  });
});

describe('mergeFromEdit (an input-side edit made from a conversion’s rules map)', () => {
  it('adds a declared column, follows a rename by id, unions aliases and takes the conversion’s reading', () => {
    const before = one();
    const source = sourceOf(before);
    const after = edited(before, (r) => {
      r.input.columns[0]!.header = 'Identifier';
      r.input.columns[0]!.aliases = ['ID'];
      r.input.columns.push({ id: 'note', header: 'Note', type: 'text' });
      r.input.headerRow = 3;
    });
    const { structure, renames } = mergeFromEdit(source, after, before);
    expect(renames).toEqual(new Map([['ID', 'Identifier']]));
    expect(structure.inputSignature.columns.map((c) => [c.header, c.aliases])).toEqual([
      ['Identifier', ['ID']],
      ['Amount', []],
      ['Note', []],
    ]);
    expect(structure.inputReading.headerRow).toBe(3);
  });

  it('a header that differs only as the engine ignores (case) is the same column, not a rename: the source keeps its spelling', () => {
    const before = one();
    const source = sourceOf(before);
    const after = edited(before, (r) => {
      r.input.columns[0]!.header = 'id';
    });
    const { structure, renames } = mergeFromEdit(source, after, before);
    expect(renames.size).toBe(0);
    expect(structure.inputSignature.columns[0]!.header).toBe('ID');
    expect(structure).toEqual(source);
    // ...and the conversion is brought to it
    expect(applySource(after, structure).rules.input.columns[0]!.header).toBe('ID');
  });

  it("its input checks replace the source's on the columns the conversion declares; the source's checks on every other column stay", () => {
    const before = edited(one(), (r) => {
      r.validations = [{ column: 'id', rule: 'required', severity: 'flag' }, { column: 'amount', rule: 'range', min: 0, severity: 'flag' }];
    });
    const own = sourceOf(before);
    const source: SourceStructure = {
      ...own,
      inputSignature: { columns: [...own.inputSignature.columns, { header: 'Note', aliases: [], type: 'text', required: false }] },
      inputValidations: [...own.inputValidations, { column: 'Note', rule: 'required', severity: 'block' }],
    };
    // the edit drops the check on ID, changes the one on Amount, and renames ID
    const after = edited(before, (r) => {
      r.input.columns[0]!.header = 'Identifier';
      r.input.columns[0]!.aliases = ['ID'];
      r.validations = [{ column: 'amount', rule: 'range', min: 1, severity: 'flag' }];
    });
    expect(mergeFromEdit(source, after, before).structure.inputValidations).toEqual([
      { column: 'Note', rule: 'required', severity: 'block' }, // a column this conversion doesn't read: not its to change
      { column: 'Amount', rule: 'range', min: 1, severity: 'flag' },
    ]);
    // a column the edit adds brings its checks, named as the source names it
    const more = edited(before, (r) => {
      r.input.columns.push({ id: 'qty', header: 'Quantity', type: 'integer' });
      r.validations.push({ column: 'qty', rule: 'required', severity: 'block' });
    });
    expect(mergeFromEdit(source, more, before).structure.inputValidations).toEqual([
      { column: 'Note', rule: 'required', severity: 'block' },
      { column: 'ID', rule: 'required', severity: 'flag' },
      { column: 'Amount', rule: 'range', min: 0, severity: 'flag' },
      { column: 'Quantity', rule: 'required', severity: 'block' },
    ]);
  });

  it('never drops an alias another conversion relies on (aliases only grow from an editor save)', () => {
    const before = one();
    const source = sourceOf(before);
    source.inputSignature.columns[0]!.aliases = ['Identifier'];
    const after = edited(before, (r) => {
      r.input.columns[0]!.aliases = ['Other'];
    });
    const { structure } = mergeFromEdit(source, after, before);
    expect(structure.inputSignature.columns[0]!.aliases).toEqual(['Identifier', 'Other']);
  });
});

describe('withSourceAliases and withDerivedRequired', () => {
  it('replace brings a conversion to the source’s aliases; union only adds', () => {
    const rules = edited(one(), (r) => {
      r.input.columns[0]!.aliases = ['Mine'];
    });
    const s = sourceOf(one());
    s.inputSignature.columns[0]!.aliases = ['Theirs'];
    expect(withSourceAliases(rules, s).input.columns[0]!.aliases).toEqual(['Theirs']);
    expect(withSourceAliases(rules, s, 'union').input.columns[0]!.aliases).toEqual(['Mine', 'Theirs']);
    // nothing but aliases changes
    expect({ ...withSourceAliases(rules, s), input: null }).toEqual({ ...rules, input: null });
  });

  it('`required` is required by at least one conversion; a column nobody declares keeps its flag', () => {
    const s = sourceOf(one());
    s.inputSignature.columns[1]!.required = true;
    const out = withDerivedRequired(s, [
      { columns: [{ header: 'id', required: true }, { header: 'Amount', required: false }] },
      { columns: [{ header: 'ID', required: false }] },
    ]);
    expect(out.inputSignature.columns.map((c) => [c.header, c.required])).toEqual([
      ['ID', true],
      ['Amount', false],
    ]);
    const nobody = withDerivedRequired(s, []);
    expect(nobody.inputSignature.columns[1]!.required).toBe(true);
  });
});

function sourceDoc(name: string, rules: Rules): SourceDoc {
  const s = sourceOf(rules);
  return {
    _id: new ObjectId(),
    ownerId: new ObjectId(),
    name,
    nameKey: name.toLowerCase(),
    ...s,
    version: 1,
    versions: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('pickReusableSource (the same matching and threshold as flow C)', () => {
  const a = sourceDoc('A', one()); // ID, Amount
  const b = sourceDoc('B', two()); // Code, Price

  it('reuses the one source the example input clearly matches', () => {
    expect(pickReusableSource([a, b], ['ID', 'Amount'])?.name).toBe('A');
    expect(pickReusableSource([a, b], ['Code', 'Price', 'Extra'])?.name).toBe('B'); // extra columns are ignored
    expect(pickReusableSource([a, b], ['id', 'AMOUNT'])?.name).toBe('A'); // normalized headers
  });

  it('does not reuse on a guess: no match, a missing column, two equally good sources, or no headers', () => {
    expect(pickReusableSource([a, b], ['Foo', 'Bar'])).toBeNull();
    expect(pickReusableSource([a, b], ['ID'])).toBeNull(); // Amount missing: 0.5 < 0.9
    const twin = sourceDoc('A twin', one());
    expect(pickReusableSource([a, twin], ['ID', 'Amount'])).toBeNull(); // no 0.1 margin
    expect(pickReusableSource([a], [])).toBeNull();
    expect(pickReusableSource([], ['ID', 'Amount'])).toBeNull();
  });

  it('never reuses a source with a required column the file lacks, even at a score of 0.9', () => {
    const wide = edited(one(), (r) => {
      for (let i = 0; i < 9; i++) r.input.columns.push({ id: `c${i}`, header: `C${i}`, type: 'text', required: true });
      r.input.columns[0]!.required = true;
    });
    const big = sourceDoc('Big', wide); // 10 required + Amount
    const headers = wide.input.columns.map((c) => c.header).filter((h) => h !== 'C8'); // 1 of 10 required missing -> 0.9
    expect(pickReusableSource([big], headers)).toBeNull();
  });
});

describe('headers a source needs no "new column" notice for', () => {
  it('newIgnoredHeaders: trimmed, never empty, one per normalized header, and none the source already ignores', () => {
    expect(newIgnoredHeaders([], ['  Notes ', 'notes', '', '   ', 'Created by'])).toEqual(['Notes', 'Created by']);
    expect(newIgnoredHeaders(['Notes'], ['NOTES', 'Remark', 'remark'])).toEqual(['Remark']);
    expect(newIgnoredHeaders(['Notes'], [])).toEqual([]);
  });

  it("unusedExampleHeaders: the example's columns no source column stands for (header, alias or normalized), blanks left out", () => {
    const columns = sourceOf(edited(one(), (r) => { r.input.columns[0]!.aliases = ['Identifier']; })).inputSignature.columns;
    expect(unusedExampleHeaders({ columns }, ['Identifier', 'id ', 'Amount', 'Notes', '', 'Created by'])).toEqual(['Notes', 'Created by']);
    expect(unusedExampleHeaders({ columns }, [])).toEqual([]);
  });
});
