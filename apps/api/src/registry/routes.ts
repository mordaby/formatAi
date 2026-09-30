// The registry routes (SPEC 8.12, 13, 5 A step 8 / A2 / C, 11): a signed-in user's saved formats and their
// conversions. Every route needs a sign-in (401 `signInRequired`) and the database (503 `unavailable`), checks
// ownership on every read and write (someone else's id is a 404, the same as a missing one), and takes ids as
// 24-hex ObjectIds. Refusals are stable codes (`ApiErrorBody`); nothing here logs rules, headers or names.
//
//   POST   /api/formats                             create a format and its first conversion
//   GET    /api/formats                             list (sources, statuses, runs)
//   GET    /api/formats/:id                         a format and its conversions
//   PATCH  /api/formats/:id                         rename
//   DELETE /api/formats/:id                         delete it and its conversions
//   POST   /api/formats/:id/conversions             attach a new source (format lock)
//   GET    /api/conversions/:id                     one conversion with its rules
//   PATCH  /api/conversions/:id                     rename / save edited rules (a format edit propagates)
//   DELETE /api/conversions/:id
//   GET    /api/conversions/:id/versions            history (newest first)
//   POST   /api/conversions/:id/restore/:version    restore an earlier version as a new one
//   POST   /api/conversions/:id/runs                count a run (counts only)
//   POST   /api/conversions/:id/aliases             save a confirmed column mapping as an alias
//   GET    /api/signatures                          every conversion's input signature (matching runs in the browser)
import { checkFormatLock } from '@formatai/engine';
import {
  limits,
  RulesSchema,
  tiers,
  type ApiErrorBody,
  type ConversionStatus,
  type ConversionVersionSummary,
  type Rules,
  type SignatureEntry,
  type Tier,
  type UpdateConversionResponse,
} from '@formatai/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ObjectId } from 'mongodb';
import type { AppDb } from '../db.js';
import type { ConversionDoc, ConversionVersion, FormatDoc } from '../models.js';
import { identityOf, type Identity } from '../protection/identity.js';
import type { Protection } from '../protection/index.js';
import { newFormatsKey } from '../protection/keys.js';
import { reserveLearn } from '../protection/reserve.js';
import {
  isRecord,
  nameKey,
  parseAlias,
  parseName,
  parseRun,
  parseSaveFields,
  parseUpdateFields,
} from './bodies.js';
import { objectIdOf } from './ids.js';
import {
  aggregateSources,
  conversionDetail,
  conversionSummary,
  formatDetail,
  formatOfDoc,
  formatSummary,
  type SourceStats,
} from './present.js';
import { applyFormat, headerRenames } from './propagate.js';
import { checkRulesFile, formatFields, lockProblems, plain, signatureOf, withMeta, type RulesCheck } from './rules.js';

export interface RegisterRegistryRoutesOptions {
  /** Null when no database is configured: every route then answers 503 `unavailable`. */
  db: AppDb | null;
  protection: Protection;
  /** Tests: who is calling (default: `identityOf`). */
  identify?: (req: FastifyRequest) => Identity;
}

interface Caller {
  ownerId: ObjectId;
  tier: Tier;
}

function fail(reply: FastifyReply, status: number, body: ApiErrorBody): FastifyReply {
  return reply.code(status).send(body);
}

/** How a rules file that failed `checkRulesFile` is answered. */
function rulesRefusal(reply: FastifyReply, checked: Extract<RulesCheck, { ok: false }>): FastifyReply {
  if (checked.onlyRuleLimit) return fail(reply, 403, { error: 'limitHit', limit: 'rulesPerFormat' });
  return fail(reply, 422, { error: 'invalidRules', problems: checked.problems });
}

/** The first "Source N" no other source of the format has. */
function freeSourceName(taken: readonly string[]): string {
  const used = new Set(taken.map(nameKey));
  for (let n = 1; ; n++) {
    const name = `Source ${n}`;
    if (!used.has(name.toLowerCase())) return name;
  }
}

export function registerRegistryRoutes(app: FastifyInstance, opts: RegisterRegistryRoutesOptions): void {
  const { db, protection } = opts;
  const identify = opts.identify ?? identityOf;

  /** Signed in (401), database there (503): the caller and the database, or null with the reply sent. */
  const guard = (req: FastifyRequest, reply: FastifyReply): { db: AppDb; caller: Caller } | null => {
    const identity = identify(req);
    const ownerId = identity.kind === 'user' ? objectIdOf(identity.userId) : undefined;
    if (identity.kind !== 'user' || !ownerId) {
      fail(reply, 401, { error: 'signInRequired' });
      return null;
    }
    if (!db) {
      fail(reply, 503, { error: 'unavailable' });
      return null;
    }
    return { db, caller: { ownerId, tier: identity.tier } };
  };

  const idParam = (req: FastifyRequest, name = 'id'): ObjectId | undefined =>
    objectIdOf((req.params as Record<string, string | undefined>)[name]);

  const ownedFormat = async (d: AppDb, c: Caller, id: ObjectId | undefined): Promise<FormatDoc | null> =>
    id ? d.formats.findOne({ _id: id, ownerId: c.ownerId }) : null;

  const ownedConversion = async (d: AppDb, c: Caller, id: ObjectId | undefined): Promise<ConversionDoc | null> =>
    id ? d.conversions.findOne({ _id: id, ownerId: c.ownerId }) : null;

  const statsOf = async (d: AppDb, c: Caller, formatId: ObjectId): Promise<SourceStats> =>
    aggregateSources(
      await d.conversions
        .find({ ownerId: c.ownerId, formatId }, { projection: { status: 1, runCount: 1, lastRunAt: 1 } })
        .toArray(),
    );

  const takenNames = async (d: AppDb, c: Caller, formatId: ObjectId, except?: ObjectId): Promise<string[]> =>
    (
      await d.conversions
        .find({ ownerId: c.ownerId, formatId, ...(except ? { _id: { $ne: except } } : {}) }, { projection: { sourceName: 1 } })
        .toArray()
    ).map((x) => x.sourceName);

  const sourcesAllowed = async (d: AppDb, c: Caller, formatId: ObjectId): Promise<boolean> => {
    const cap = tiers[c.tier].sourcesPerFormat;
    if (cap === 'unlimited') return true;
    return (await d.conversions.countDocuments({ ownerId: c.ownerId, formatId })) < cap;
  };

  const versionCap = limits.registry.maxVersions;

  // ---------------------------------------------------------------- formats

  app.post('/api/formats', async (req, reply) => {
    const g = guard(req, reply);
    if (!g) return reply;
    const { db: d, caller } = g;

    const body = isRecord(req.body) ? req.body : null;
    const name = body ? parseName(body.name) : null;
    const fields = body ? parseSaveFields(body) : null;
    const sourceName = body ? (body.sourceName === undefined ? 'Source 1' : parseName(body.sourceName)) : null;
    if (!body || !name || !fields || !sourceName) return fail(reply, 400, { error: 'invalidRequest' });

    const now = protection.now();
    const formatId = new ObjectId();
    const checked = checkRulesFile(
      withMeta(fields.rules, { ...fields, name, formatId: formatId.toHexString(), sourceName, now }),
      caller.tier,
    );
    if (!checked.ok) return rulesRefusal(reply, checked);
    const rules = checked.rules;

    // SPEC 11: saved formats (delete frees a slot), sources per format, and DECISION 9: paid = N NEW formats a month.
    const tier = tiers[caller.tier];
    if (
      typeof tier.savedFormats === 'number' &&
      (await d.formats.countDocuments({ ownerId: caller.ownerId })) >= tier.savedFormats
    ) {
      return fail(reply, 403, { error: 'limitHit', limit: 'savedFormats' });
    }
    if (tier.sourcesPerFormat === 0) return fail(reply, 403, { error: 'limitHit', limit: 'sourcesPerFormat' });

    let monthly: { key: string } | null = null;
    if (tier.newSavedFormatsPerMonth !== undefined) {
      const key = newFormatsKey(caller.ownerId.toHexString(), now);
      const reservation = await reserveLearn(protection.store, [
        { key, limit: tier.newSavedFormatsPerMonth, limitCode: 'newFormatsPerMonth' },
      ]);
      if (!reservation.ok) return fail(reply, 429, { error: 'limitHit', limit: 'newFormatsPerMonth' });
      monthly = { key };
    }

    const format = formatFields(rules);
    const formatDoc: FormatDoc = {
      _id: formatId,
      ownerId: caller.ownerId,
      name,
      schemaVersion: 1,
      output: plain(format.output),
      layout: plain(format.layout),
      outputValidations: plain(format.outputValidations),
      origin: 'learned',
      version: 1,
      versions: [],
      createdAt: now,
      updatedAt: now,
    };
    const conversionDoc: ConversionDoc = {
      _id: new ObjectId(),
      ownerId: caller.ownerId,
      formatId,
      sourceName,
      schemaVersion: 1,
      rules: plain(rules),
      inputSignature: signatureOf(rules),
      source: fields.source,
      status: fields.status,
      acceptedDifferences: fields.acceptedDifferences,
      exampleExceptions: fields.exampleExceptions,
      learnPath: fields.learnPath,
      masking: fields.masking,
      ...(fields.model !== undefined ? { model: fields.model } : {}),
      ...(fields.promptVersion !== undefined ? { promptVersion: fields.promptVersion } : {}),
      version: 1,
      versions: [],
      runCount: 0,
      createdAt: now,
      updatedAt: now,
    };

    try {
      await d.formats.insertOne(formatDoc);
      await d.conversions.insertOne(conversionDoc);
    } catch (err) {
      // No half-saved format, and the month's count is given back: nothing was created.
      await d.formats.deleteOne({ _id: formatId }).catch(() => undefined);
      if (monthly) await protection.store.incrementCounter(monthly.key, -1).catch(() => undefined);
      throw err;
    }

    return reply.code(201).send({
      format: formatSummary(formatDoc, aggregateSources([conversionDoc])),
      conversion: conversionSummary(conversionDoc),
    });
  });

  app.get('/api/formats', async (req, reply) => {
    const g = guard(req, reply);
    if (!g) return reply;
    const { db: d, caller } = g;

    const formats = await d.formats
      .find({ ownerId: caller.ownerId }, { projection: { versions: 0 } })
      .sort({ createdAt: -1, _id: -1 })
      .limit(limits.registry.maxFormatsListed)
      .toArray();
    const conversions = await d.conversions
      .find({ ownerId: caller.ownerId }, { projection: { formatId: 1, status: 1, runCount: 1, lastRunAt: 1 } })
      .toArray();
    const byFormat = new Map<string, typeof conversions>();
    for (const c of conversions) {
      const key = c.formatId.toHexString();
      const list = byFormat.get(key);
      if (list) list.push(c);
      else byFormat.set(key, [c]);
    }
    return reply.send({
      formats: formats.map((f) => formatSummary(f, aggregateSources(byFormat.get(f._id!.toHexString()) ?? []))),
    });
  });

  app.get('/api/formats/:id', async (req, reply) => {
    const g = guard(req, reply);
    if (!g) return reply;
    const { db: d, caller } = g;

    const format = await ownedFormat(d, caller, idParam(req));
    if (!format) return fail(reply, 404, { error: 'notFound' });
    const conversions = await d.conversions
      .find({ ownerId: caller.ownerId, formatId: format._id! }, { projection: { rules: 0, versions: 0 } })
      .sort({ createdAt: 1, _id: 1 })
      .toArray();
    return reply.send({
      format: formatDetail(format, aggregateSources(conversions)),
      conversions: conversions.map(conversionSummary),
    });
  });

  app.patch('/api/formats/:id', async (req, reply) => {
    const g = guard(req, reply);
    if (!g) return reply;
    const { db: d, caller } = g;

    const format = await ownedFormat(d, caller, idParam(req));
    if (!format) return fail(reply, 404, { error: 'notFound' });
    const name = isRecord(req.body) ? parseName(req.body.name) : null;
    if (!name) return fail(reply, 400, { error: 'invalidRequest' });

    const updatedAt = protection.now();
    await d.formats.updateOne({ _id: format._id!, ownerId: caller.ownerId }, { $set: { name, updatedAt } });
    return reply.send({ format: formatSummary({ ...format, name, updatedAt }, await statsOf(d, caller, format._id!)) });
  });

  app.delete('/api/formats/:id', async (req, reply) => {
    const g = guard(req, reply);
    if (!g) return reply;
    const { db: d, caller } = g;

    const format = await ownedFormat(d, caller, idParam(req));
    if (!format) return fail(reply, 404, { error: 'notFound' });
    // Deleting frees a saved-format slot and never refunds AI learns or this month's new-format count.
    const removed = await d.conversions.deleteMany({ ownerId: caller.ownerId, formatId: format._id! });
    await d.formats.deleteOne({ _id: format._id!, ownerId: caller.ownerId });
    return reply.send({ deleted: true, conversions: removed.deletedCount });
  });

  // ------------------------------------------------- attach a source (A2)

  app.post('/api/formats/:id/conversions', async (req, reply) => {
    const g = guard(req, reply);
    if (!g) return reply;
    const { db: d, caller } = g;

    const format = await ownedFormat(d, caller, idParam(req));
    if (!format) return fail(reply, 404, { error: 'notFound' });
    const body = isRecord(req.body) ? req.body : null;
    const fields = body ? parseSaveFields(body) : null;
    const requested = body && body.sourceName !== undefined ? parseName(body.sourceName) : undefined;
    if (!body || !fields || requested === null) return fail(reply, 400, { error: 'invalidRequest' });

    const formatId = format._id!;
    if (!(await sourcesAllowed(d, caller, formatId))) return fail(reply, 403, { error: 'limitHit', limit: 'sourcesPerFormat' });

    const taken = await takenNames(d, caller, formatId);
    const sourceName = requested ?? freeSourceName(taken);
    if (taken.some((t) => nameKey(t) === nameKey(sourceName))) return fail(reply, 409, { error: 'nameTaken' });

    const now = protection.now();
    const checked = checkRulesFile(
      withMeta(fields.rules, { ...fields, name: format.name, formatId: formatId.toHexString(), sourceName, now }),
      caller.tier,
    );
    if (!checked.ok) return rulesRefusal(reply, checked);
    const rules = checked.rules;

    // SPEC 8.12: the output side must equal the format's (except `from`), else say which columns differ.
    const mismatch = lockProblems(rules, formatOfDoc(format));
    if (mismatch.length > 0) return fail(reply, 422, { error: 'formatMismatch', problems: mismatch });

    const doc: ConversionDoc = {
      _id: new ObjectId(),
      ownerId: caller.ownerId,
      formatId,
      sourceName,
      schemaVersion: 1,
      rules: plain(rules),
      inputSignature: signatureOf(rules),
      source: fields.source,
      status: fields.status,
      acceptedDifferences: fields.acceptedDifferences,
      exampleExceptions: fields.exampleExceptions,
      learnPath: fields.learnPath,
      masking: fields.masking,
      ...(fields.model !== undefined ? { model: fields.model } : {}),
      ...(fields.promptVersion !== undefined ? { promptVersion: fields.promptVersion } : {}),
      version: 1,
      versions: [],
      runCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    await d.conversions.insertOne(doc);
    return reply.code(201).send({ conversion: conversionSummary(doc) });
  });

  // ------------------------------------------------------- conversions

  app.get('/api/conversions/:id', async (req, reply) => {
    const g = guard(req, reply);
    if (!g) return reply;
    const conversion = await ownedConversion(g.db, g.caller, idParam(req));
    if (!conversion) return fail(reply, 404, { error: 'notFound' });
    return reply.send({ conversion: conversionDetail(conversion) });
  });

  /** What one save writes to a conversion's own fields (its rules, signature and counts). */
  const conversionWrite = (
    from: ConversionDoc,
    to: { rules: Rules; sourceName: string; status: ConversionStatus; acceptedDifferences: number; exampleExceptions: number[] },
    now: Date,
  ): ConversionDoc => ({
    ...from,
    rules: plain(to.rules),
    inputSignature: signatureOf(to.rules),
    sourceName: to.sourceName,
    status: to.status,
    acceptedDifferences: to.acceptedDifferences,
    exampleExceptions: to.exampleExceptions,
    version: from.version + 1,
    updatedAt: now,
  });

  const snapshotOf = (c: ConversionDoc, ownerId: ObjectId): ConversionVersion => ({
    version: c.version,
    rules: c.rules,
    status: c.status,
    acceptedDifferences: c.acceptedDifferences,
    editedBy: ownerId,
    at: c.updatedAt,
  });

  /** Writes `next` over `prev` if `prev` is still the stored version (compare-and-set); the old one goes to history. */
  const saveVersion = async (d: AppDb, ownerId: ObjectId, prev: ConversionDoc, next: ConversionDoc): Promise<boolean> => {
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
        $push: { versions: { $each: [snapshotOf(prev, ownerId)], $slice: -versionCap } },
      },
    );
    return res.matchedCount > 0;
  };

  app.patch('/api/conversions/:id', async (req, reply) => {
    const g = guard(req, reply);
    if (!g) return reply;
    const { db: d, caller } = g;

    const conv = await ownedConversion(d, caller, idParam(req));
    if (!conv) return fail(reply, 404, { error: 'notFound' });
    const update = isRecord(req.body) ? parseUpdateFields(req.body) : null;
    if (!update) return fail(reply, 400, { error: 'invalidRequest' });
    if (update.baseVersion !== undefined && update.baseVersion !== conv.version) {
      return fail(reply, 409, { error: 'versionConflict' });
    }

    const now = protection.now();
    let sourceName = conv.sourceName;
    if (update.sourceName !== undefined) {
      if (nameKey(update.sourceName) !== nameKey(conv.sourceName)) {
        const taken = await takenNames(d, caller, conv.formatId, conv._id!);
        if (taken.some((t) => nameKey(t) === nameKey(update.sourceName!))) return fail(reply, 409, { error: 'nameTaken' });
      }
      sourceName = update.sourceName;
    }

    // ---- a rename only: not a new version of the rules, but the copy of the name inside them follows ----
    if (!update.save) {
      const res = await d.conversions.updateOne(
        { _id: conv._id!, ownerId: caller.ownerId },
        { $set: { sourceName, 'rules.meta.sourceName': sourceName, updatedAt: now } },
      );
      if (res.matchedCount === 0) return fail(reply, 404, { error: 'notFound' });
      const body: UpdateConversionResponse = {
        conversion: conversionSummary({ ...conv, sourceName, updatedAt: now }),
        formatChanged: false,
        affectedSources: 0,
        needsReview: [],
      };
      return reply.send(body);
    }

    // ---- a rules save: a new version (SPEC 8.11 "Saving") ----
    const format = await ownedFormat(d, caller, conv.formatId);
    if (!format) return fail(reply, 404, { error: 'notFound' });

    const save = update.save;
    const before = conv.rules as Rules;
    const checked = checkRulesFile(
      withMeta(save.rules, {
        name: before.name,
        formatId: format._id!.toHexString(),
        sourceName,
        status: save.status,
        source: conv.source,
        learnPath: conv.learnPath,
        masking: conv.masking,
        ...(conv.model !== undefined ? { model: conv.model } : {}),
        ...(conv.promptVersion !== undefined ? { promptVersion: conv.promptVersion } : {}),
        now: conv.createdAt,
      }),
      caller.tier,
    );
    if (!checked.ok) return rulesRefusal(reply, checked);
    const rules = checked.rules;

    // SPEC 8.12: an edit that changes the output side changes the FORMAT, for all its sources.
    const formatChanged = checkFormatLock(rules, formatOfDoc(format)).length > 0;

    const next = conversionWrite(
      conv,
      {
        rules,
        sourceName,
        status: save.status,
        acceptedDifferences: save.acceptedDifferences,
        exampleExceptions: save.exampleExceptions ?? conv.exampleExceptions,
      },
      now,
    );
    if (!(await saveVersion(d, caller.ownerId, conv, next))) return fail(reply, 409, { error: 'versionConflict' });

    const affected: { id: string; sourceName: string }[] = [];
    let others = 0;
    if (formatChanged) {
      const changed = formatFields(rules);
      const applied = await d.formats.updateOne(
        { _id: format._id!, ownerId: caller.ownerId, version: format.version },
        {
          $set: {
            output: plain(changed.output),
            layout: plain(changed.layout),
            outputValidations: plain(changed.outputValidations),
            version: format.version + 1,
            updatedAt: now,
          },
          $push: {
            versions: {
              $each: [
                {
                  version: format.version,
                  format: { output: format.output, layout: format.layout, outputValidations: format.outputValidations },
                  editedBy: caller.ownerId,
                  at: format.updatedAt,
                },
              ],
              $slice: -versionCap,
            },
          },
        },
      );
      if (applied.matchedCount === 0) {
        // Someone changed the format meanwhile: give this conversion back, so it never disagrees with the format.
        await d.conversions.updateOne(
          { _id: conv._id!, ownerId: caller.ownerId, version: next.version },
          {
            $set: {
              rules: conv.rules,
              inputSignature: conv.inputSignature,
              sourceName: conv.sourceName,
              status: conv.status,
              acceptedDifferences: conv.acceptedDifferences,
              exampleExceptions: conv.exampleExceptions,
              version: conv.version,
              updatedAt: conv.updatedAt,
            },
            $pop: { versions: 1 },
          },
        );
        return fail(reply, 409, { error: 'versionConflict' });
      }

      // Every other source of the format takes the new output side (SPEC 8.12 "Editing a format").
      const newFormat = formatOfDoc(changed);
      const renames = headerRenames(before, rules);
      const siblings = await d.conversions
        .find({ ownerId: caller.ownerId, formatId: format._id!, _id: { $ne: conv._id! } })
        .toArray();
      others = siblings.length;
      for (const sibling of siblings) {
        for (let attempt = 0; attempt < 3; attempt++) {
          const cur = attempt === 0 ? sibling : await d.conversions.findOne({ _id: sibling._id!, ownerId: caller.ownerId });
          if (!cur) break;
          const parsed = RulesSchema.safeParse(cur.rules);
          let written: ConversionDoc;
          if (parsed.success) {
            const propagated = applyFormat(parsed.data as unknown as Rules, newFormat, renames);
            const status: ConversionStatus = propagated.needsReview ? 'needsReview' : cur.status;
            const rewritten: Rules = { ...propagated.rules, meta: { ...propagated.rules.meta, status } };
            written = conversionWrite(
              cur,
              { rules: rewritten, sourceName: cur.sourceName, status, acceptedDifferences: cur.acceptedDifferences, exampleExceptions: cur.exampleExceptions },
              now,
            );
          } else {
            // Stored rules that no longer parse cannot be rebuilt: leave them, flagged for review.
            written = { ...cur, status: 'needsReview', version: cur.version + 1, updatedAt: now };
          }
          if (await saveVersion(d, caller.ownerId, cur, written)) {
            if (written.status === 'needsReview') affected.push({ id: cur._id!.toHexString(), sourceName: cur.sourceName });
            break;
          }
        }
      }
    }

    const body: UpdateConversionResponse = {
      conversion: conversionSummary(next),
      formatChanged,
      affectedSources: others,
      needsReview: affected,
    };
    return reply.send(body);
  });

  app.delete('/api/conversions/:id', async (req, reply) => {
    const g = guard(req, reply);
    if (!g) return reply;
    const conversion = await ownedConversion(g.db, g.caller, idParam(req));
    if (!conversion) return fail(reply, 404, { error: 'notFound' });
    // The format stays, even with no sources left (a format need not have been learned, SPEC 8.12).
    await g.db.conversions.deleteOne({ _id: conversion._id!, ownerId: g.caller.ownerId });
    return reply.send({ deleted: true });
  });

  app.get('/api/conversions/:id/versions', async (req, reply) => {
    const g = guard(req, reply);
    if (!g) return reply;
    const id = idParam(req);
    const conv = id
      ? await g.db.conversions.findOne(
          { _id: id, ownerId: g.caller.ownerId },
          { projection: { rules: 0, 'versions.rules': 0 } },
        )
      : null;
    if (!conv) return fail(reply, 404, { error: 'notFound' });

    const versions: ConversionVersionSummary[] = [
      {
        version: conv.version,
        at: conv.updatedAt.toISOString(),
        status: conv.status,
        acceptedDifferences: conv.acceptedDifferences,
        current: true,
      },
      ...[...conv.versions].reverse().map(
        (v): ConversionVersionSummary => ({
          version: v.version,
          at: v.at.toISOString(),
          status: v.status,
          acceptedDifferences: v.acceptedDifferences,
          current: false,
        }),
      ),
    ];
    return reply.send({ versions });
  });

  app.post('/api/conversions/:id/restore/:version', async (req, reply) => {
    const g = guard(req, reply);
    if (!g) return reply;
    const { db: d, caller } = g;

    const conv = await ownedConversion(d, caller, idParam(req));
    const wanted = Number((req.params as Record<string, string>).version);
    if (!conv || !Number.isInteger(wanted)) return fail(reply, 404, { error: 'notFound' });
    const old = conv.versions.find((v) => v.version === wanted);
    if (!old) return fail(reply, 404, { error: 'notFound' });
    const format = await ownedFormat(d, caller, conv.formatId);
    if (!format) return fail(reply, 404, { error: 'notFound' });

    const now = protection.now();
    const oldMeta = isRecord(old.rules) && isRecord(old.rules.meta) ? old.rules.meta : {};
    const checked = checkRulesFile(
      withMeta(old.rules, {
        name: (conv.rules as Rules).name,
        formatId: format._id!.toHexString(),
        sourceName: conv.sourceName,
        status: old.status,
        source: conv.source,
        learnPath: conv.learnPath,
        masking: conv.masking,
        ...(conv.model !== undefined ? { model: conv.model } : {}),
        ...(conv.promptVersion !== undefined ? { promptVersion: conv.promptVersion } : {}),
        now: typeof oldMeta.createdAt === 'string' ? new Date(oldMeta.createdAt) : conv.createdAt,
      }),
      caller.tier,
    );
    if (!checked.ok) return rulesRefusal(reply, checked);
    // An older version from before a change to the format cannot come back on its own (SPEC 8.12 format lock).
    const mismatch = lockProblems(checked.rules, formatOfDoc(format));
    if (mismatch.length > 0) return fail(reply, 422, { error: 'formatMismatch', problems: mismatch });

    const next = conversionWrite(
      conv,
      {
        rules: checked.rules,
        sourceName: conv.sourceName,
        status: old.status,
        acceptedDifferences: old.acceptedDifferences,
        exampleExceptions: conv.exampleExceptions,
      },
      now,
    );
    if (!(await saveVersion(d, caller.ownerId, conv, next))) return fail(reply, 409, { error: 'versionConflict' });
    return reply.send({ conversion: conversionSummary(next) });
  });

  app.post('/api/conversions/:id/runs', async (req, reply) => {
    const g = guard(req, reply);
    if (!g) return reply;
    const conv = await ownedConversion(g.db, g.caller, idParam(req));
    if (!conv) return fail(reply, 404, { error: 'notFound' });
    const run = isRecord(req.body) ? parseRun(req.body) : null;
    if (!run) return fail(reply, 400, { error: 'invalidRequest' });

    // Counts only: never rows, values or file names (SPEC 14.1, 15).
    const lastRunAt = protection.now();
    const updated = await g.db.conversions.findOneAndUpdate(
      { _id: conv._id!, ownerId: g.caller.ownerId },
      { $inc: { runCount: 1 }, $set: { lastRunAt, lastRun: run } },
      { returnDocument: 'after', projection: { runCount: 1 } },
    );
    if (!updated) return fail(reply, 404, { error: 'notFound' });
    return reply.send({ runCount: updated.runCount, lastRunAt: lastRunAt.toISOString() });
  });

  app.post('/api/conversions/:id/aliases', async (req, reply) => {
    const g = guard(req, reply);
    if (!g) return reply;
    const { db: d, caller } = g;

    const conv = await ownedConversion(d, caller, idParam(req));
    if (!conv) return fail(reply, 404, { error: 'notFound' });
    const request = isRecord(req.body) ? parseAlias(req.body) : null;
    if (!request) return fail(reply, 400, { error: 'invalidRequest' });

    const parsed = RulesSchema.safeParse(conv.rules);
    if (!parsed.success) return fail(reply, 422, { error: 'invalidRules' });
    const rules = parsed.data as unknown as Rules;
    const column = rules.input.columns.find((c) => c.header === request.header);
    if (!column) return fail(reply, 400, { error: 'invalidRequest' });

    const key = nameKey(request.alias);
    const clash = rules.input.columns.some(
      (c) => c !== column && (nameKey(c.header) === key || (c.aliases ?? []).some((a) => nameKey(a) === key)),
    );
    if (clash) return fail(reply, 409, { error: 'aliasConflict' });

    const aliases = column.aliases ?? [];
    const known = nameKey(column.header) === key || aliases.some((a) => nameKey(a) === key);
    if (!known) {
      if (aliases.length >= limits.registry.maxAliasesPerColumn) return fail(reply, 400, { error: 'invalidRequest' });
      column.aliases = [...aliases, request.alias];
      // DECISION: a confirmed mapping is part of the rules but not an edit in the rules map, so it does not
      // make a new version (a restore would otherwise be filled with one-alias versions).
      const applied = await d.conversions.updateOne(
        { _id: conv._id!, ownerId: caller.ownerId, version: conv.version },
        { $set: { rules: plain(rules), inputSignature: signatureOf(rules) } },
      );
      if (applied.matchedCount === 0) return fail(reply, 409, { error: 'versionConflict' });
    }
    return reply.send({ inputSignature: signatureOf(rules) });
  });

  // ------------------------------------------------------- signatures

  app.get('/api/signatures', async (req, reply) => {
    const g = guard(req, reply);
    if (!g) return reply;
    const { db: d, caller } = g;

    const [formats, conversions] = await Promise.all([
      d.formats.find({ ownerId: caller.ownerId }, { projection: { name: 1 } }).toArray(),
      d.conversions
        .find({ ownerId: caller.ownerId }, { projection: { formatId: 1, sourceName: 1, status: 1, inputSignature: 1 } })
        .toArray(),
    ]);
    const nameOf = new Map(formats.map((f) => [f._id!.toHexString(), f.name] as const));
    const signatures: SignatureEntry[] = conversions.map((c) => ({
      conversionId: c._id!.toHexString(),
      formatId: c.formatId.toHexString(),
      formatName: nameOf.get(c.formatId.toHexString()) ?? '',
      sourceName: c.sourceName,
      status: c.status,
      columns: c.inputSignature.columns,
    }));
    return reply.send({ signatures });
  });

}
