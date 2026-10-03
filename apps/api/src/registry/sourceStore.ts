// Writing sources (SPEC 8.15, 13): creating one, a versioned edit, deriving its `required` flags, and writing a source's
// structure into all of its conversions ("Editing a source propagates to all its conversions, like a format edit").
// Database helpers around the pure functions of `sourceLogic.ts`; every write is scoped by `ownerId`.
import { deepEqual } from '@formatai/engine';
import { limits, RulesSchema, type ConversionStatus, type Rules, type SourceStructure } from '@formatai/shared';
import type { ObjectId } from 'mongodb';
import type { AppDb } from '../db.js';
import type { ConversionDoc, SourceDoc } from '../models.js';
import { nameKey } from './bodies.js';
import { conversionWrite, saveVersion } from './conversionStore.js';
import { plain, signatureOf } from './rules.js';
import { applySource, newIgnoredHeaders, structureOfDoc, withDerivedRequired, withSourceAliases } from './sourceLogic.js';

/** The first "Source N" no other source of the owner has. */
export function freeSourceName(taken: readonly string[]): string {
  const used = new Set(taken.map(nameKey));
  for (let n = 1; ; n++) {
    const name = `Source ${n}`;
    if (!used.has(nameKey(name))) return name;
  }
}

/** How many formats a source feeds: the distinct formats of its conversions (SPEC 8.15). */
export async function countSourceFormats(d: AppDb, ownerId: ObjectId, sourceId: ObjectId): Promise<number> {
  return (await d.conversions.distinct('formatId', { ownerId, sourceId })).length;
}

export async function takenSourceNames(d: AppDb, ownerId: ObjectId, except?: ObjectId): Promise<string[]> {
  return (
    await d.sources.find({ ownerId, ...(except ? { _id: { $ne: except } } : {}) }, { projection: { name: 1 } }).toArray()
  ).map((s) => s.name);
}

/** MongoDB's duplicate-key error: the (ownerId, nameKey) index refused a name that is already in use. */
export function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 11000;
}

/** A new source document (version 1) for `structure`, named `name`. Not yet inserted. */
export function newSourceDoc(ownerId: ObjectId, name: string, structure: SourceStructure, now: Date, id?: ObjectId): SourceDoc {
  const s = plain(structure);
  return {
    ...(id ? { _id: id } : {}),
    ownerId,
    name,
    nameKey: nameKey(name),
    inputSignature: s.inputSignature,
    inputReading: s.inputReading,
    inputValidations: s.inputValidations,
    version: 1,
    versions: [],
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Writes a new version of a source's structure if it is still at `prev.version` (compare-and-set); the replaced version goes to
 * `versions` (SPEC 13, capped like the other histories). Null when someone changed it meanwhile.
 */
export async function writeSourceVersion(
  d: AppDb,
  ownerId: ObjectId,
  prev: SourceDoc,
  structure: SourceStructure,
  now: Date,
): Promise<SourceDoc | null> {
  const s = plain(structure);
  const res = await d.sources.updateOne(
    { _id: prev._id!, ownerId, version: prev.version },
    {
      $set: {
        inputSignature: s.inputSignature,
        inputReading: s.inputReading,
        inputValidations: s.inputValidations,
        version: prev.version + 1,
        updatedAt: now,
      },
      $push: {
        versions: {
          $each: [{ version: prev.version, source: structureOfDoc(prev), editedBy: ownerId, at: prev.updatedAt }],
          $slice: -limits.registry.maxVersions,
        },
      },
    },
  );
  if (res.matchedCount === 0) return null;
  return { ...prev, ...s, version: prev.version + 1, updatedAt: now };
}

/**
 * Recomputes the source's `required` flags from its conversions (SPEC 8.15 DECISION: required by at least one conversion) and
 * stores them if they changed. Derived data, not an edit: no new version.
 */
export async function syncRequired(d: AppDb, ownerId: ObjectId, sourceId: ObjectId): Promise<void> {
  const source = await d.sources.findOne({ _id: sourceId, ownerId });
  if (!source) return;
  const conversions = await d.conversions.find({ ownerId, sourceId }, { projection: { inputSignature: 1 } }).toArray();
  const before = structureOfDoc(source);
  const after = withDerivedRequired(before, conversions.map((c) => c.inputSignature));
  if (deepEqual(before.inputSignature, after.inputSignature)) return;
  await d.sources.updateOne({ _id: sourceId, ownerId }, { $set: { inputSignature: after.inputSignature } });
}

/**
 * Remembers file headers a source needs no "new column" notice for (SPEC 8.15): the ones it does not hold yet are appended (one per
 * normalized header), and past `limits.registry.maxIgnoredHeaders` the OLDEST are dropped, so a dismissal just made always holds. Names
 * only. Derived/remembered data, not an edit of the structure: no new version, and no conversion is touched. One atomic update, so
 * two dismissals at once cannot lose each other. Null when the source is not the owner's; else every header the source now ignores.
 */
export async function addIgnoredHeaders(d: AppDb, ownerId: ObjectId, sourceId: ObjectId, headers: readonly string[]): Promise<string[] | null> {
  const source = await d.sources.findOne({ _id: sourceId, ownerId }, { projection: { ignoredHeaders: 1 } });
  if (!source) return null;
  const fresh = newIgnoredHeaders(source.ignoredHeaders ?? [], headers);
  if (fresh.length === 0) return source.ignoredHeaders ?? [];
  const after = await d.sources.findOneAndUpdate(
    { _id: sourceId, ownerId },
    { $push: { ignoredHeaders: { $each: fresh, $slice: -limits.registry.maxIgnoredHeaders } } },
    { returnDocument: 'after', projection: { ignoredHeaders: 1 } },
  );
  return after ? (after.ignoredHeaders ?? []) : null;
}

/** Renames a source; the conversions' rules files follow (`meta.sourceName` is informational: the source's own name is the only name). */
export async function renameSource(d: AppDb, ownerId: ObjectId, source: SourceDoc, name: string, now: Date): Promise<void> {
  await d.sources.updateOne({ _id: source._id!, ownerId }, { $set: { name, nameKey: nameKey(name), updatedAt: now } });
  await d.conversions.updateMany(
    { ownerId, sourceId: source._id! },
    { $set: { 'rules.meta.sourceName': name } },
  );
}

export interface PropagateOptions {
  /** Leave this conversion alone (the one whose save started the change). */
  except?: ObjectId;
  /**
   * Only aliases can differ (an alias was added to the source): written in place, with no new version of the conversion - a
   * confirmed mapping is not an edit in the rules map (the same DECISION the alias route always had), and a restore would
   * otherwise be filled with one-alias versions.
   */
  aliasesOnly?: boolean;
}

export interface Propagated {
  /** Conversions of the source the change was offered to (all of them but `except`). */
  conversions: number;
  /** Of those, the ones whose rules no longer resolve and now need review. */
  needsReview: { id: ObjectId; formatId: ObjectId }[];
}

/**
 * SPEC 8.15 "Editing a source": writes `structure` into every conversion of the source. A conversion whose rewritten rules
 * don't resolve (references, types, source lock) is stored that way, marked `needsReview` (its example files aren't kept, so it
 * is re-verified by whoever opens it); one that is already as the source says is left untouched.
 */
export async function propagateSource(
  d: AppDb,
  ownerId: ObjectId,
  sourceId: ObjectId,
  structure: SourceStructure,
  renames: ReadonlyMap<string, string>,
  now: Date,
  opts: PropagateOptions = {},
): Promise<Propagated> {
  const filter = { ownerId, sourceId, ...(opts.except ? { _id: { $ne: opts.except } } : {}) };
  const siblings = await d.conversions.find(filter).toArray();
  const flagged: Propagated['needsReview'] = [];

  for (const sibling of siblings) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const cur = attempt === 0 ? sibling : await d.conversions.findOne({ _id: sibling._id!, ownerId });
      if (!cur) break;

      const parsed = RulesSchema.safeParse(cur.rules);
      if (!parsed.success) {
        // Stored rules that no longer parse cannot be rebuilt: leave them, flagged for review.
        const written: ConversionDoc = { ...cur, status: 'needsReview', version: cur.version + 1, updatedAt: now };
        if (await saveVersion(d, ownerId, cur, written)) {
          flagged.push({ id: cur._id!, formatId: cur.formatId });
          break;
        }
        continue;
      }

      const before = parsed.data as unknown as Rules;
      if (opts.aliasesOnly) {
        // Only what the source has learned about how files name a column: nothing else of the conversion is looked at.
        const rules = withSourceAliases(before, structure, 'union');
        if (deepEqual(before, rules)) break;
        const res = await d.conversions.updateOne(
          { _id: cur._id!, ownerId, version: cur.version },
          { $set: { rules: plain(rules), inputSignature: signatureOf(rules) } },
        );
        if (res.matchedCount > 0) break;
        continue;
      }

      const applied = applySource(before, structure, renames);
      if (!applied.changed && !applied.needsReview) break;

      const status: ConversionStatus = applied.needsReview ? 'needsReview' : cur.status;
      const rules: Rules = { ...applied.rules, meta: { ...applied.rules.meta, status } };

      const written = conversionWrite(
        cur,
        { rules, status, acceptedDifferences: cur.acceptedDifferences, exampleExceptions: cur.exampleExceptions },
        now,
      );
      if (await saveVersion(d, ownerId, cur, written)) {
        if (applied.needsReview) flagged.push({ id: cur._id!, formatId: cur.formatId });
        break;
      }
    }
  }
  return { conversions: siblings.length, needsReview: flagged };
}
