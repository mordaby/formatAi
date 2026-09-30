// Which source does a conversion being saved belong to, and what does saving do to it (SPEC 8.15 "Saving")?
//
//   * an explicit `sourceId`: that source (404 if it isn't the caller's, 422 `sourceMismatch` if the conversion doesn't fit it);
//   * an explicit `newSource`: a new source with that name, never a reuse (409 `nameTaken` if the name is in use);
//   * neither: the caller's source the example input MATCHES (the same matching and threshold as flow C - `pickReusableSource`)
//     is REUSED and the caller is told; otherwise a new source, named by the legacy `sourceName` or the first free "Source N".
//
// `planSource` decides and refuses; it writes nothing. `commitSource` performs the source's part of the save, and `settleSource`
// finishes it once the conversion is stored.
import { checkSourceLock, sourceOf } from '@formatai/engine';
import type { ApiErrorBody, Rules, SourceLockProblem, SourceStructure } from '@formatai/shared';
import type { ObjectId } from 'mongodb';
import type { AppDb } from '../db.js';
import type { SourceDoc } from '../models.js';
import { nameKey, type SourceChoiceFields } from './bodies.js';
import { applySource, mergeForReuse, pickReusableSource, structureOfDoc } from './sourceLogic.js';
import { freeSourceName, isDuplicateKey, newSourceDoc, propagateSource, syncRequired, writeSourceVersion } from './sourceStore.js';

export type SourcePlan =
  | { kind: 'new'; name: string; structure: SourceStructure }
  | {
      kind: 'reuse';
      doc: SourceDoc;
      /** The source with the conversion's columns and aliases merged in. */
      merged: SourceStructure;
      /** The merge added a column or an alias: the source needs a new version. */
      changed: boolean;
      /** The caller named the source (`sourceId`) rather than letting the server match one. */
      explicit: boolean;
    };

export type Refusal = { status: number; body: ApiErrorBody };
export type PlanResult = { ok: true; plan: SourcePlan; rules: Rules } | ({ ok: false } & Refusal);

const refuse = (status: number, body: ApiErrorBody): PlanResult => ({ ok: false, status, body });

export const planName = (plan: SourcePlan): string => (plan.kind === 'new' ? plan.name : plan.doc.name);

/**
 * Chooses the source for `rules` (the conversion being saved) and the rules as they will be stored: for a reuse, the conversion's
 * input side is conformed to the merged source (its aliases become the source's), so the source lock holds by construction.
 * `feedsFormat` says whether a source already feeds the format being attached to (A2): the server never reuses one that does on its
 * own - a second conversion from the same source into the same format is not what "matches an existing source" means.
 */
export async function planSource(
  d: AppDb,
  ownerId: ObjectId,
  args: { rules: Rules; choice: SourceChoiceFields; feedsFormat?: (sourceId: ObjectId) => Promise<boolean> },
): Promise<PlanResult> {
  const { rules, choice } = args;

  /** The plan for using `doc`, or what stops the conversion from fitting it. */
  const tryReuse = (doc: SourceDoc, explicit: boolean): { plan: SourcePlan } | { problems: SourceLockProblem[] } => {
    const merge = mergeForReuse(structureOfDoc(doc), rules);
    if (!merge.ok) return { problems: merge.problems };
    return { plan: { kind: 'reuse', doc, merged: merge.structure, changed: merge.changed, explicit } };
  };
  /** The plan with the rules conformed to it. */
  const settle = (plan: SourcePlan): PlanResult => {
    if (plan.kind === 'new') return { ok: true, plan, rules };
    const applied = applySource(rules, plan.merged);
    if (applied.needsReview) return refuse(422, { error: 'sourceMismatch', problems: applied.problems });
    return { ok: true, plan, rules: applied.rules };
  };

  if (choice.sourceId) {
    const doc = await d.sources.findOne({ _id: choice.sourceId, ownerId });
    if (!doc) return refuse(404, { error: 'notFound' });
    const r = tryReuse(doc, true);
    return 'plan' in r ? settle(r.plan) : refuse(422, { error: 'sourceMismatch', problems: r.problems });
  }

  const owned = await d.sources.find({ ownerId }).sort({ createdAt: 1, _id: 1 }).toArray();

  if (choice.newSourceName === undefined) {
    // DECISION: the headers the rules DECLARE stand in for the example input's headers when the client sends none. A rules file
    // declares only the columns some rule reads, so this is a subset of the file's: the match is then more cautious, never looser.
    const headers = choice.inputHeaders ?? rules.input.columns.map((c) => c.header);
    const candidate = pickReusableSource(owned, headers);
    if (candidate && !(await args.feedsFormat?.(candidate._id!))) {
      const r = tryReuse(candidate, false);
      // A source the conversion doesn't fit (a column typed differently, another way of reading the file) is not reused: a new one is
      // made instead. (An explicit reuse, above, says why it doesn't fit.)
      if ('plan' in r) return settle(r.plan);
    }
  }

  const taken = owned.map((s) => s.name);
  const name = choice.newSourceName ?? choice.sourceName ?? freeSourceName(taken);
  if (taken.some((t) => nameKey(t) === nameKey(name))) return refuse(409, { error: 'nameTaken' });
  return settle({ kind: 'new', name, structure: sourceOf(rules) });
}

/** What the source's part of a save did. */
export interface CommittedSource {
  id: ObjectId;
  name: string;
  /** An existing source was used. */
  reused: boolean;
  /** The source was created by this save (so a failed save can take it away again). */
  created: boolean;
}

/**
 * Performs the source's part of a save: inserts the new source, or - for a reuse whose merge added a column or an alias - writes the
 * source's next version. A concurrent edit of the source is merged with again (a few times) before giving up with `versionConflict`.
 * `rules` are the rules as they will be stored.
 */
export async function commitSource(
  d: AppDb,
  ownerId: ObjectId,
  plan: SourcePlan,
  rules: Rules,
  now: Date,
): Promise<{ ok: true; source: CommittedSource } | ({ ok: false } & Refusal)> {
  if (plan.kind === 'new') {
    try {
      const res = await d.sources.insertOne(newSourceDoc(ownerId, plan.name, plan.structure, now));
      return { ok: true, source: { id: res.insertedId, name: plan.name, reused: false, created: true } };
    } catch (e) {
      if (isDuplicateKey(e)) return { ok: false, status: 409, body: { error: 'nameTaken' } };
      throw e;
    }
  }

  let current = plan.doc;
  let merged = plan.merged;
  let changed = plan.changed;
  for (let attempt = 0; changed; attempt++) {
    if (await writeSourceVersion(d, ownerId, current, merged, now)) break;
    // Someone edited the source meanwhile: merge again on top of what is stored now.
    const fresh = await d.sources.findOne({ _id: current._id!, ownerId });
    if (!fresh || attempt >= 2) return { ok: false, status: 409, body: { error: 'versionConflict' } };
    const again = mergeForReuse(structureOfDoc(fresh), rules);
    if (!again.ok) return { ok: false, status: 422, body: { error: 'sourceMismatch', problems: again.problems } };
    current = fresh;
    merged = again.structure;
    changed = again.changed;
  }
  return { ok: true, source: { id: current._id!, name: current.name, reused: true, created: false } };
}

/** After the conversion is stored: bring every conversion of a reused source up to its aliases, and derive `required`. */
export async function settleSource(d: AppDb, ownerId: ObjectId, sourceId: ObjectId, plan: SourcePlan, now: Date): Promise<void> {
  if (plan.kind === 'reuse' && plan.changed) {
    const doc = await d.sources.findOne({ _id: sourceId, ownerId });
    if (doc) await propagateSource(d, ownerId, sourceId, structureOfDoc(doc), new Map(), now, { aliasesOnly: true });
  }
  await syncRequired(d, ownerId, sourceId);
}

/** The source lock as an API refusal, or null when `rules` honours it. */
export function sourceLockRefusal(rules: Rules, structure: SourceStructure): Refusal | null {
  const problems = checkSourceLock(rules, structure);
  return problems.length > 0 ? { status: 422, body: { error: 'sourceMismatch', problems } } : null;
}
