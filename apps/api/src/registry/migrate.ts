// Migrating to sources (SPEC 8.15, 13, 21 v6): before sources existed every conversion carried its own input signature and
// `sourceName`. This groups each owner's conversions that have no `sourceId` yet into sources and links them. Never touches a
// rules file: a source is BUILT from the conversions' rules (`sourceOf`), and the conversions only gain `sourceId`.
//
// Split in two like the rest of the registry: `planSourceMigration` is pure (unit-tested without a database), `runSourceMigration`
// reads and writes. Idempotent: a conversion that already has a `sourceId` is never looked at again, so a second run finds nothing
// to do; `dryRun` reads everything and writes nothing.
//
// GROUPING (DECISIONS)
//  - Per owner - different owners never merge.
//  - Two conversions share a source when their input signatures are IDENTICAL AFTER NORMALIZATION: the same set of columns compared
//    by header the way matching compares them (`normalizeText`, case-insensitive: `sourceHeaderKey`), each with the same type,
//    `padLeft` and `inputFormats`. Aliases and `required` are ignored for grouping (a source unions the aliases and derives `required`:
//    required by at least one conversion). Column ORDER is ignored too (a file's columns are found by header, not by position).
//  - Also identical: the reading options (sheet pick, header row, stopAt) and the input checks. The source lock (8.15) makes those
//    equal for every conversion of a source, and a migration that never touches rules can only honour the lock by not merging
//    conversions that differ there. (Two conversions of one file that differ only in those stay two sources - never a wrong merge.)
//  - A source is named after the first conversion of its group (oldest first) - its `sourceName` - made unique among the owner's
//    sources ("Name (2)", ...). Its structure is that conversion's, with the group's aliases added.
import { sourceHeaderKey, sourceOf } from '@formatai/engine';
import { RulesSchema, type Rules, type SourceColumn, type SourceStructure } from '@formatai/shared';
import type { ObjectId } from 'mongodb';
import type { AppDb } from '../db.js';
import type { ConversionDoc } from '../models.js';
import { nameKey } from './bodies.js';
import { newSourceDoc } from './sourceStore.js';

/** What the migration reads of a conversion. */
export type LegacyConversion = Pick<ConversionDoc, '_id' | 'ownerId' | 'sourceName' | 'rules' | 'inputSignature' | 'createdAt'> & {
  sourceId?: ObjectId | undefined;
};

export interface PlannedSource {
  name: string;
  /** Header count of the source's signature. */
  columns: number;
  structure: SourceStructure;
  /** The conversions it links, oldest first. */
  conversions: ObjectId[];
}

export interface PlannedOwner {
  ownerId: ObjectId;
  sources: PlannedSource[];
}

export interface MigrationPlan {
  owners: PlannedOwner[];
  /** Conversions that already have a source: left alone. */
  alreadyLinked: number;
}

const sortedKeys = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(sortedKeys);
  if (typeof v === 'object' && v !== null) {
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, sortedKeys((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
};

/** The structure of a conversion, from its rules (or, if they no longer parse, from its stored signature alone). */
function structureOf(conv: LegacyConversion): SourceStructure {
  const parsed = RulesSchema.safeParse(conv.rules);
  if (parsed.success) return sourceOf(parsed.data as unknown as Rules);
  // DECISION: a conversion whose stored rules don't parse can't say how it reads the file: it gets the default reading and no
  // checks, and (having no way to show otherwise) will merge only with conversions that read the same way.
  const columns = conv.inputSignature?.columns ?? [];
  return {
    inputSignature: { columns: columns.map((c) => ({ header: c.header, aliases: [...c.aliases], type: c.type as SourceColumn['type'], required: c.required })) },
    inputReading: { sheet: { pick: 'first' }, headerRow: 'auto' },
    inputValidations: [],
  };
}

/** The grouping key (see the file header): the structure with headers normalized, aliases and `required` left out. */
export function groupingKey(structure: SourceStructure): string {
  const columns = structure.inputSignature.columns
    .map((c) => ({ h: sourceHeaderKey(c.header), t: c.type, p: c.padLeft ?? null, f: c.inputFormats ?? [] }))
    .sort((a, b) => (a.h < b.h ? -1 : a.h > b.h ? 1 : 0));
  const validations = structure.inputValidations
    .map((v) => JSON.stringify(sortedKeys({ ...v, column: sourceHeaderKey(v.column) })))
    .sort();
  return JSON.stringify({ columns, reading: sortedKeys(structure.inputReading), validations });
}

/** A name not in `used` (by `nameKey`): "Name", then "Name (2)", "Name (3)", ... */
function uniqueName(name: string, used: Set<string>): string {
  let candidate = name;
  for (let n = 2; used.has(nameKey(candidate)); n++) candidate = `${name} (${n})`;
  used.add(nameKey(candidate));
  return candidate;
}

/**
 * Plans the migration. Pure. `existingNames` = names (by owner hex) of sources that already exist, which a planned source must not
 * take. A source of a group is the FIRST conversion's structure with the group's aliases added.
 */
export function planSourceMigration(conversions: readonly LegacyConversion[], existingNames: ReadonlyMap<string, readonly string[]> = new Map()): MigrationPlan {
  const plan: MigrationPlan = { owners: [], alreadyLinked: 0 };
  const byOwner = new Map<string, LegacyConversion[]>();
  for (const c of conversions) {
    if (c.sourceId) {
      plan.alreadyLinked++;
      continue;
    }
    const key = c.ownerId.toHexString();
    const list = byOwner.get(key);
    if (list) list.push(c);
    else byOwner.set(key, [c]);
  }

  for (const [owner, list] of [...byOwner.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const ordered = [...list].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a._id!.toHexString() < b._id!.toHexString() ? -1 : 1));
    const used = new Set((existingNames.get(owner) ?? []).map(nameKey));
    const groups = new Map<string, { first: LegacyConversion; structure: SourceStructure; conversions: ObjectId[] }>();

    for (const conv of ordered) {
      const structure = structureOf(conv);
      const key = groupingKey(structure);
      const group = groups.get(key);
      if (!group) {
        groups.set(key, { first: conv, structure: JSON.parse(JSON.stringify(structure)) as SourceStructure, conversions: [conv._id!] });
        continue;
      }
      group.conversions.push(conv._id!);
      // The group's aliases, and `required` by at least one conversion (SPEC 8.15 DECISION).
      for (const c of structure.inputSignature.columns) {
        const into = group.structure.inputSignature.columns.find((x) => sourceHeaderKey(x.header) === sourceHeaderKey(c.header))!;
        for (const a of c.aliases) if (a !== into.header && !into.aliases.includes(a)) into.aliases.push(a);
        if (c.required) into.required = true;
      }
    }

    plan.owners.push({
      ownerId: ordered[0]!.ownerId,
      sources: [...groups.values()].map((g) => ({
        name: uniqueName(g.first.sourceName, used),
        columns: g.structure.inputSignature.columns.length,
        structure: g.structure,
        conversions: g.conversions,
      })),
    });
  }
  return plan;
}

export interface MigrationSummary extends MigrationPlan {
  dryRun: boolean;
  sourcesCreated: number;
  conversionsLinked: number;
}

/**
 * Reads every conversation without a `sourceId`, plans, and - unless `dryRun` - creates the sources and links the conversions. The
 * unique (ownerId, name) index guards the names; a source is written before its conversions are linked, so a run that stops halfway
 * leaves at worst a source with no conversion (a second run then makes a "(2)" for that group - harmless, and deletable).
 */
export async function runSourceMigration(d: AppDb, opts: { dryRun: boolean; now?: Date } = { dryRun: false }): Promise<MigrationSummary> {
  const legacy = await d.conversions
    .find({}, { projection: { ownerId: 1, sourceName: 1, rules: 1, inputSignature: 1, createdAt: 1, sourceId: 1 } })
    .toArray();
  const existing = new Map<string, string[]>();
  for (const s of await d.sources.find({}, { projection: { ownerId: 1, name: 1 } }).toArray()) {
    const key = s.ownerId.toHexString();
    existing.set(key, [...(existing.get(key) ?? []), s.name]);
  }

  const plan = planSourceMigration(legacy, existing);
  const summary: MigrationSummary = { ...plan, dryRun: opts.dryRun, sourcesCreated: 0, conversionsLinked: 0 };
  if (opts.dryRun) return summary;

  const now = opts.now ?? new Date();
  for (const owner of plan.owners) {
    for (const source of owner.sources) {
      const doc = newSourceDoc(owner.ownerId, source.name, source.structure, now);
      const res = await d.sources.insertOne(doc);
      // Only the ones that still have no source (a concurrent run, or a half-finished earlier one, must not be overwritten).
      const linked = await d.conversions.updateMany(
        { _id: { $in: source.conversions }, ownerId: owner.ownerId, sourceId: { $exists: false } },
        { $set: { sourceId: res.insertedId } },
      );
      summary.sourcesCreated++;
      summary.conversionsLinked += linked.modifiedCount;
    }
  }
  return summary;
}

/** The dry-run / result report, line by line (also what `pnpm migrate:sources` prints). */
export function describeMigration(summary: MigrationSummary, dbName: string): string[] {
  const lines: string[] = [`migrate:sources${summary.dryRun ? ' (dry run: nothing is written)' : ''} - database "${dbName}"`];
  if (summary.owners.length === 0) lines.push('  nothing to do: every conversion already has a source');
  for (const owner of summary.owners) {
    const n = owner.sources.reduce((sum, s) => sum + s.conversions.length, 0);
    lines.push(`owner ${owner.ownerId.toHexString()}: ${n} conversion${n === 1 ? '' : 's'} without a source`);
    for (const s of owner.sources) {
      const feeds = s.conversions.length === 1 ? '1 conversion' : `merges ${s.conversions.length} conversions`;
      lines.push(`  ${summary.dryRun ? 'would create' : 'created'} source "${s.name}" - ${s.columns} column${s.columns === 1 ? '' : 's'} - ${feeds}`);
    }
  }
  const sources = summary.owners.reduce((sum, o) => sum + o.sources.length, 0);
  const links = summary.owners.reduce((sum, o) => sum + o.sources.reduce((s2, s) => s2 + s.conversions.length, 0), 0);
  lines.push(
    `${summary.dryRun ? 'would create' : 'created'} ${sources} source${sources === 1 ? '' : 's'}, link ${links} conversion${links === 1 ? '' : 's'}; ${summary.alreadyLinked} already linked (skipped)`,
  );
  return lines;
}
