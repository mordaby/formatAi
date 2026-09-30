// Writing a conversion (SPEC 8.11 "Saving", 8.12): what one save writes, and the compare-and-set that keeps two saves from
// silently overwriting each other. Shared by the conversion routes, the format edit (SPEC 8.12) and the source edit (SPEC 8.15),
// which all end with "write these rules as the conversion's next version".
import { limits, type ConversionStatus, type Rules } from '@formatai/shared';
import type { ObjectId } from 'mongodb';
import type { AppDb } from '../db.js';
import type { ConversionDoc, ConversionVersion } from '../models.js';
import { plain, signatureOf } from './rules.js';

export const versionCap = (): number => limits.registry.maxVersions;

/** What one save writes to a conversion's own fields (its rules, signature and counts): the next version of `from`. */
export function conversionWrite(
  from: ConversionDoc,
  to: { rules: Rules; sourceName: string; status: ConversionStatus; acceptedDifferences: number; exampleExceptions: number[] },
  now: Date,
): ConversionDoc {
  return {
    ...from,
    rules: plain(to.rules),
    inputSignature: signatureOf(to.rules),
    sourceName: to.sourceName,
    status: to.status,
    acceptedDifferences: to.acceptedDifferences,
    exampleExceptions: to.exampleExceptions,
    version: from.version + 1,
    updatedAt: now,
  };
}

export function snapshotOf(c: ConversionDoc, ownerId: ObjectId): ConversionVersion {
  return {
    version: c.version,
    rules: c.rules,
    status: c.status,
    acceptedDifferences: c.acceptedDifferences,
    editedBy: ownerId,
    at: c.updatedAt,
  };
}

/** Writes `next` over `prev` if `prev` is still the stored version (compare-and-set); the old one goes to history. */
export async function saveVersion(d: AppDb, ownerId: ObjectId, prev: ConversionDoc, next: ConversionDoc): Promise<boolean> {
  const res = await d.conversions.updateOne(
    { _id: prev._id!, ownerId, version: prev.version },
    {
      $set: {
        rules: next.rules,
        inputSignature: next.inputSignature,
        sourceName: next.sourceName,
        status: next.status,
        acceptedDifferences: next.acceptedDifferences,
        exampleExceptions: next.exampleExceptions,
        version: next.version,
        updatedAt: next.updatedAt,
      },
      $push: { versions: { $each: [snapshotOf(prev, ownerId)], $slice: -versionCap() } },
    },
  );
  return res.matchedCount > 0;
}
