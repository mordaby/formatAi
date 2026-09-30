// The pure half of sources (no database): merging a saved conversion into an existing source, writing a source's structure into
// a conversion, choosing the source a file belongs to, and grouping conversions for the migration (SPEC 8.15).
import { checkSourceLock, sourceOf } from '@formatai/engine';
import type { LearnResult, Rules, SourceStructure } from '@formatai/shared';
import { ObjectId } from 'mongodb';
import { describe, expect, it } from 'vitest';
import type { SourceDoc } from '../../src/models.js';
import { groupingKey, planSourceMigration, type LegacyConversion } from '../../src/registry/migrate.js';
import { checkRulesFile, signatureOf, withMeta } from '../../src/registry/rules.js';
import { applySource, mergeForReuse, mergeFromEdit, pickReusableSource, withDerivedRequired, withSourceAliases } from '../../src/registry/sourceLogic.js';
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

    const check = edited(one(), (r) => {
      r.validations.push({ column: 'amount', rule: 'range', min: 0, severity: 'flag' });
    });
    const v = mergeForReuse(source, check);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.problems.map((p) => p.path)).toEqual(['validations']);
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

  it('is a no-op for a conversion already as the source says', () => {
    const applied = applySource(one(), sourceOf(one()));
    expect(applied).toMatchObject({ changed: false, needsReview: false, problems: [] });
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

// ---------------------------------------------------------------- migration grouping (pure)

const owner1 = new ObjectId();
const owner2 = new ObjectId();
let clock = 0;
function legacy(ownerId: ObjectId, sourceName: string, rules: Rules, over: Partial<LegacyConversion> = {}): LegacyConversion {
  return { _id: new ObjectId(), ownerId, sourceName, rules, inputSignature: signatureOf(rules), createdAt: new Date(2026, 8, 1, 0, 0, clock++), ...over };
}

describe('planSourceMigration (grouping conversions into sources)', () => {
  it('merges conversions whose signatures are identical after normalization (case, quotes, order; aliases ignored) into one source', () => {
    const a = legacy(owner1, 'Supplier A', one());
    const b = legacy(
      owner1,
      'Supplier A (copy)',
      edited(one(), (r) => {
        r.input.columns.reverse();
        r.input.columns.find((c) => c.id === 'id')!.header = ' id ';
        r.input.columns.find((c) => c.id === 'id')!.aliases = ['Identifier'];
        r.input.columns.find((c) => c.id === 'amount')!.required = true;
      }),
    );
    const plan = planSourceMigration([a, b]);
    expect(plan.owners).toHaveLength(1);
    const [source] = plan.owners[0]!.sources;
    expect(plan.owners[0]!.sources).toHaveLength(1);
    expect(source!.name).toBe('Supplier A'); // the first (oldest) conversion's
    expect(source!.columns).toBe(2);
    expect(source!.conversions).toEqual([a._id, b._id]);
    // the group's aliases are unioned and `required` is required by at least one
    expect(source!.structure.inputSignature.columns.map((c) => [c.header, c.aliases, c.required])).toEqual([
      ['ID', ['Identifier'], false],
      ['Amount', [], true],
    ]);
  });

  it('keeps different signatures apart (other headers, other types) and never merges across owners', () => {
    const a = legacy(owner1, 'A', one());
    const b = legacy(owner1, 'B', two());
    const typed = legacy(owner1, 'C', edited(one(), (r) => { r.input.columns[1]!.type = 'text'; }));
    const otherOwner = legacy(owner2, 'A', one());
    const plan = planSourceMigration([a, b, typed, otherOwner]);
    expect(plan.owners.map((o) => o.sources.map((s) => s.name))).toEqual([['A', 'B', 'C'], ['A']]);
    expect(plan.owners.every((o) => o.sources.every((s) => s.conversions.length === 1))).toBe(true);
  });

  it('keeps apart conversions the source lock could not hold together: another way of reading the file, or other input checks', () => {
    const a = legacy(owner1, 'A', one());
    const sheet = legacy(owner1, 'B', edited(one(), (r) => { r.input.sheet = { pick: 'name', name: 'Data' }; }));
    const check = legacy(owner1, 'C', edited(one(), (r) => { r.validations.push({ column: 'id', rule: 'required', severity: 'flag' }); }));
    const same = legacy(owner1, 'D', edited(one(), (r) => { r.validations.push({ on: 'output', column: 'ID', rule: 'unique', severity: 'flag' }); }));
    const plan = planSourceMigration([a, sheet, check, same]);
    // D differs from A only by an OUTPUT check (the format's business): it joins A's source
    expect(plan.owners[0]!.sources.map((s) => [s.name, s.conversions.length])).toEqual([['A', 2], ['B', 1], ['C', 1]]);
  });

  it('skips conversions that already have a source, and names a source uniquely (also against existing ones)', () => {
    const linked = legacy(owner1, 'Old', one(), { sourceId: new ObjectId() });
    const a = legacy(owner1, 'Same name', one());
    const b = legacy(owner1, 'Same name', two());
    const c = legacy(owner1, 'Taken', asRules(edited(sourceOne(), (r) => { r.input.columns[0]!.header = 'K'; r.output.columns[0]!.from = 'id'; })));
    const plan = planSourceMigration([linked, a, b, c], new Map([[owner1.toHexString(), ['taken']]]));
    expect(plan.alreadyLinked).toBe(1);
    expect(plan.owners[0]!.sources.map((s) => s.name)).toEqual(['Same name', 'Same name (2)', 'Taken (2)']);
  });

  it('the grouping key ignores aliases, required and column order but not headers, types or shapes', () => {
    const base = sourceOf(one());
    const key = groupingKey(base);
    const shuffled: SourceStructure = JSON.parse(JSON.stringify(base));
    shuffled.inputSignature.columns.reverse();
    shuffled.inputSignature.columns[0]!.aliases = ['x'];
    shuffled.inputSignature.columns[1]!.required = true;
    expect(groupingKey(shuffled)).toBe(key);
    const padded: SourceStructure = JSON.parse(JSON.stringify(base));
    padded.inputSignature.columns[0]!.padLeft = 9;
    expect(groupingKey(padded)).not.toBe(key);
  });

  it('plans nothing when there is nothing to migrate', () => {
    expect(planSourceMigration([])).toEqual({ owners: [], alreadyLinked: 0 });
  });
});
