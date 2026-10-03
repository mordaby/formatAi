// The source routes (SPEC 8.15, 13): the company's sources - one kind of incoming file each - and the formats they feed. Same rules as
// the rest of the registry: signed in (401), database there (503), ownership checked on every read and write (someone else's id is a
// 404), stable refusal codes, nothing logged.
//
//   GET    /api/sources                  every source with the formats it feeds (one line per conversion)
//   GET    /api/sources/:id              one source with its structure (headers, types, reading options, input checks)
//   PATCH  /api/sources/:id              rename, and/or edit the structure: a new version, written to every conversion of it
//   DELETE /api/sources/:id              only when it feeds no format (409 sourceInUse)
//   POST   /api/sources/:id/aliases      a confirmed column mapping, saved once for every format the source feeds
import { deepEqual, findSourceColumn, sourceHeaderKey } from '@formatai/engine';
import {
  limits,
  type ApiErrorBody,
  type SourceColumn,
  type SourceStructure,
  type UpdateSourceResponse,
} from '@formatai/shared';
import type { FastifyInstance } from 'fastify';
import type { ObjectId } from 'mongodb';
import type { AppDb } from '../db.js';
import type { SourceDoc } from '../models.js';
import { isRecord, nameKey, parseAlias, parseSourceUpdate } from './bodies.js';
import { fail, type RegistryContext } from './context.js';
import { sourceDetail, sourceSummary } from './present.js';
import { structureOfDoc } from './sourceLogic.js';
import { isDuplicateKey, propagateSource, renameSource, syncRequired, takenSourceNames, writeSourceVersion } from './sourceStore.js';

/** Format id (hex) -> name, for the formats of `conversions`. */
export async function formatNamesOf(d: AppDb, ownerId: ObjectId, conversions: readonly { formatId: ObjectId }[]): Promise<Map<string, string>> {
  const ids = [...new Map(conversions.map((c) => [c.formatId.toHexString(), c.formatId] as const)).values()];
  if (ids.length === 0) return new Map();
  const formats = await d.formats.find({ ownerId, _id: { $in: ids } }, { projection: { name: 1 } }).toArray();
  return new Map(formats.map((f) => [f._id!.toHexString(), f.name] as const));
}

export type AliasResult = { ok: true; source: SourceDoc } | { ok: false; status: number; body: ApiErrorBody };

/**
 * SPEC 5 C: a confirmed mapping ("the file's header `alias` is the source's column `header`") is saved ONCE, as an alias on the
 * source, and reaches every conversion of it. DECISION (the alias route's old one, kept): not an edit in the rules map, so no new
 * version of the source or of its conversions.
 */
export async function addSourceAlias(d: AppDb, ownerId: ObjectId, source: SourceDoc, request: { header: string; alias: string }, now: Date): Promise<AliasResult> {
  const columns = source.inputSignature.columns;
  let at = columns.findIndex((c) => c.header === request.header);
  if (at < 0) at = findSourceColumn(columns, request.header);
  if (at < 0) return { ok: false, status: 400, body: { error: 'invalidRequest' } };
  const column = columns[at]!;

  const key = nameKey(request.alias);
  const clash = columns.some((c, i) => i !== at && (nameKey(c.header) === key || c.aliases.some((a) => nameKey(a) === key)));
  if (clash) return { ok: false, status: 409, body: { error: 'aliasConflict' } };

  const known = nameKey(column.header) === key || column.aliases.some((a) => nameKey(a) === key);
  if (known) return { ok: true, source };
  if (column.aliases.length >= limits.registry.maxAliasesPerColumn) return { ok: false, status: 400, body: { error: 'invalidRequest' } };

  const next = structureOfDoc(source);
  next.inputSignature.columns[at]!.aliases = [...column.aliases, request.alias];
  const applied = await d.sources.updateOne(
    { _id: source._id!, ownerId, version: source.version },
    { $set: { inputSignature: next.inputSignature } },
  );
  if (applied.matchedCount === 0) return { ok: false, status: 409, body: { error: 'versionConflict' } };
  await propagateSource(d, ownerId, source._id!, next, new Map(), now, { aliasesOnly: true });
  return { ok: true, source: { ...source, inputSignature: next.inputSignature } };
}

export function registerSourceRoutes(app: FastifyInstance, ctx: RegistryContext): void {
  const { guard, idParam, ownedSource, protection } = ctx;

  app.get('/api/sources', async (req, reply) => {
    const g = guard(req, reply);
    if (!g) return reply;
    const { db: d, caller } = g;

    const sources = await d.sources.find({ ownerId: caller.ownerId }).sort({ createdAt: 1, _id: 1 }).limit(limits.registry.maxSourcesListed).toArray();
    const conversions = await d.conversions
      .find({ ownerId: caller.ownerId }, { projection: { sourceId: 1, formatId: 1, status: 1, runCount: 1, lastRunAt: 1 } })
      .sort({ createdAt: 1, _id: 1 })
      .toArray();
    const names = await formatNamesOf(d, caller.ownerId, conversions);
    const bySource = new Map<string, typeof conversions>();
    for (const c of conversions) {
      const key = c.sourceId.toHexString();
      const list = bySource.get(key);
      if (list) list.push(c);
      else bySource.set(key, [c]);
    }
    return reply.send({ sources: sources.map((s) => sourceSummary(s, bySource.get(s._id!.toHexString()) ?? [], names)) });
  });

  /** A source with the conversions it feeds, as the wire shape. */
  const detailOf = async (d: AppDb, ownerId: ObjectId, source: SourceDoc) => {
    const conversions = await d.conversions
      .find({ ownerId, sourceId: source._id! }, { projection: { sourceId: 1, formatId: 1, status: 1, runCount: 1, lastRunAt: 1 } })
      .sort({ createdAt: 1, _id: 1 })
      .toArray();
    return sourceDetail(source, conversions, await formatNamesOf(d, ownerId, conversions));
  };

  app.get('/api/sources/:id', async (req, reply) => {
    const g = guard(req, reply);
    if (!g) return reply;
    const source = await ownedSource(g.db, g.caller, idParam(req));
    if (!source) return fail(reply, 404, { error: 'notFound' });
    return reply.send({ source: await detailOf(g.db, g.caller.ownerId, source) });
  });

  app.patch('/api/sources/:id', async (req, reply) => {
    const g = guard(req, reply);
    if (!g) return reply;
    const { db: d, caller } = g;
    const ownerId = caller.ownerId;

    const source = await ownedSource(d, caller, idParam(req));
    if (!source) return fail(reply, 404, { error: 'notFound' });
    const update = isRecord(req.body) ? parseSourceUpdate(req.body) : null;
    if (!update) return fail(reply, 400, { error: 'invalidRequest' });
    if (update.baseVersion !== undefined && update.baseVersion !== source.version) return fail(reply, 409, { error: 'versionConflict' });

    const now = protection.now();
    let current = source;

    // ---- the name: unique among the caller's sources, whatever the case ----
    const renaming = update.name !== undefined && update.name !== source.name;
    if (renaming && nameKey(update.name!) !== nameKey(source.name)) {
      const taken = await takenSourceNames(d, ownerId, source._id!);
      if (taken.some((t) => nameKey(t) === nameKey(update.name!))) return fail(reply, 409, { error: 'nameTaken' });
    }

    // ---- the structure: a new version, written to every conversion of the source (SPEC 8.15 "Editing a source") ----
    let structureChanged = false;
    let propagated: Awaited<ReturnType<typeof propagateSource>> = { conversions: 0, needsReview: [] };
    if (update.inputSignature || update.inputReading || update.inputValidations) {
      const before = structureOfDoc(source);
      const built = buildStructure(before, update);
      if ('refusal' in built) return fail(reply, built.refusal.status, built.refusal.body);
      if (!deepEqual(built.structure, before)) {
        const written = await writeSourceVersion(d, ownerId, source, built.structure, now);
        if (!written) return fail(reply, 409, { error: 'versionConflict' });
        current = written;
        structureChanged = true;
        propagated = await propagateSource(d, ownerId, source._id!, built.structure, built.renames, now);
      }
    }

    if (renaming) {
      try {
        await renameSource(d, ownerId, current, update.name!, now);
      } catch (e) {
        if (isDuplicateKey(e)) return fail(reply, 409, { error: 'nameTaken' });
        throw e;
      }
    }
    await syncRequired(d, ownerId, source._id!);

    const fresh = (await d.sources.findOne({ _id: source._id!, ownerId })) ?? current;
    const flagged = await d.conversions.find({ ownerId, _id: { $in: propagated.needsReview.map((f) => f.id) } }, { projection: { formatId: 1 } }).toArray();
    const names = await formatNamesOf(d, ownerId, flagged);
    const body: UpdateSourceResponse = {
      source: await detailOf(d, ownerId, fresh),
      structureChanged,
      affectedConversions: propagated.conversions,
      needsReview: propagated.needsReview.map((f) => ({ id: f.id.toHexString(), formatId: f.formatId.toHexString(), formatName: names.get(f.formatId.toHexString()) ?? '' })),
    };
    return reply.send(body);
  });

  app.delete('/api/sources/:id', async (req, reply) => {
    const g = guard(req, reply);
    if (!g) return reply;
    const { db: d, caller } = g;
    const source = await ownedSource(d, caller, idParam(req));
    if (!source) return fail(reply, 404, { error: 'notFound' });
    // A source that still feeds a format is not deleted from under it (SPEC 8.15); remove its conversions first.
    if ((await d.conversions.countDocuments({ ownerId: caller.ownerId, sourceId: source._id! })) > 0) return fail(reply, 409, { error: 'sourceInUse' });
    await d.sources.deleteOne({ _id: source._id!, ownerId: caller.ownerId });
    return reply.send({ deleted: true });
  });

  app.post('/api/sources/:id/aliases', async (req, reply) => {
    const g = guard(req, reply);
    if (!g) return reply;
    const { db: d, caller } = g;
    const source = await ownedSource(d, caller, idParam(req));
    if (!source) return fail(reply, 404, { error: 'notFound' });
    const request = isRecord(req.body) ? parseAlias(req.body) : null;
    if (!request) return fail(reply, 400, { error: 'invalidRequest' });

    const res = await addSourceAlias(d, caller.ownerId, source, request, protection.now());
    if (!res.ok) return fail(reply, res.status, res.body);
    await syncRequired(d, caller.ownerId, source._id!);
    return reply.send({
      inputSignature: {
        columns: res.source.inputSignature.columns.map((c) => ({ header: c.header, aliases: c.aliases, type: c.type, required: c.required })),
      },
    });
  });
}

/**
 * The structure a PATCH asks for, on top of `before`: the columns as sent (a column not sent is removed; `was` names the header a
 * renamed one had), the reading options and input checks as sent (or unchanged). `required` is derived from the conversions
 * (SPEC 8.15 DECISION), so an existing column keeps the flag it has - only a column the source didn't have takes the one sent.
 */
function buildStructure(
  before: SourceStructure,
  update: NonNullable<ReturnType<typeof parseSourceUpdate>>,
): { structure: SourceStructure; renames: Map<string, string> } | { refusal: { status: number; body: ApiErrorBody } } {
  const bad = { refusal: { status: 400, body: { error: 'invalidRequest' } as ApiErrorBody } };
  const renames = new Map<string, string>();
  let columns: SourceColumn[] = before.inputSignature.columns;

  if (update.inputSignature) {
    const seen = new Set<string>();
    columns = [];
    for (const edit of update.inputSignature.columns) {
      const { was, ...sent } = edit;
      const key = sourceHeaderKey(sent.header);
      if (seen.has(key)) return bad;
      seen.add(key);
      if (sent.aliases.length > limits.registry.maxAliasesPerColumn) return bad;
      if ([sent.header, ...sent.aliases].some((h) => h.length > limits.registry.maxAliasChars)) return bad;

      const old = before.inputSignature.columns.find((c) => c.header === (was ?? sent.header));
      if (was !== undefined && old && was !== sent.header) renames.set(was, sent.header);
      const aliases = [...new Set(sent.aliases.filter((a) => a !== sent.header))];
      columns.push({ ...sent, aliases, required: old ? old.required : sent.required });
    }
    // An alias may not stand for two columns (it would make a file's header ambiguous).
    const owner = new Map<string, number>();
    for (const [i, c] of columns.entries()) {
      for (const h of [c.header, ...c.aliases]) {
        const k = nameKey(h);
        if (owner.has(k) && owner.get(k) !== i) return { refusal: { status: 409, body: { error: 'aliasConflict' } } };
        owner.set(k, i);
      }
    }
  }

  return {
    renames,
    structure: {
      inputSignature: { columns },
      inputReading: update.inputReading ?? before.inputReading,
      inputValidations: update.inputValidations ?? before.inputValidations,
    },
  };
}
