// The registry routes (SPEC 8.12, 8.15, 13, 5 A step 8 / A2 / C, 11): a signed-in user's saved formats, their conversions and the
// sources those read. Every route needs a sign-in (401 `signInRequired`) and the database (503 `unavailable`), checks ownership on
// every read and write (someone else's id is a 404, the same as a missing one), and takes ids as 24-hex ObjectIds. Refusals are
// stable codes (`ApiErrorBody`); nothing here logs rules, headers or names.
//
//   POST   /api/formats                             create a format, its source (or reuse one) and its first conversion
//   GET    /api/formats                             list (sources, statuses, runs)
//   GET    /api/formats/:id                         a format and its conversions
//   PATCH  /api/formats/:id                         rename
//   DELETE /api/formats/:id                         delete it and its conversions (its sources stay)
//   POST   /api/formats/:id/conversions             attach a source (format lock, source lock; reuses a matching one)
//   GET    /api/conversions/:id                     one conversion with its rules
//   PATCH  /api/conversions/:id                     rename its source / save edited rules (a format or source edit propagates)
//   DELETE /api/conversions/:id                     (its source stays)
//   GET    /api/conversions/:id/versions            history (newest first)
//   POST   /api/conversions/:id/restore/:version    restore an earlier version as a new one
//   POST   /api/conversions/:id/runs                count a run (counts only)
//   POST   /api/conversions/:id/aliases             save a confirmed column mapping as an alias (forwarded to its source)
//   GET    /api/signatures                          every source's input signature with the formats it feeds (matching runs in the browser)
//   ...and the source routes of `sourceRoutes.ts`.
import { checkFormatLock, checkSourceLock, deepEqual } from '@formatai/engine';
import {
  limits,
  RulesSchema,
  tiers,
  type ConversionStatus,
  type ConversionVersionSummary,
  type CreateFormatResponse,
  type AttachSourceResponse,
  type Rules,
  type SignatureEntry,
  type SourceStructure,
  type UpdateConversionResponse,
} from '@formatai/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ObjectId } from 'mongodb';
import type { AppDb } from '../db.js';
import type { ConversionDoc, FormatDoc, SourceDoc } from '../models.js';
import type { Identity } from '../protection/identity.js';
import type { Protection } from '../protection/index.js';
import { newFormatsKey } from '../protection/keys.js';
import { reserveLearn } from '../protection/reserve.js';
import { isRecord, nameKey, parseAlias, parseName, parseRun, parseSaveFields, parseSourceChoice, parseUpdateFields } from './bodies.js';
import { createRegistryContext, fail, type Caller } from './context.js';
import { conversionWrite, saveVersion, versionCap } from './conversionStore.js';
import {
  aggregateSources,
  conversionDetail,
  conversionSummary,
  formatDetail,
  formatOfDoc,
  formatSummary,
  signatureEntry,
  type SourceStats,
} from './present.js';
import { applyFormat, headerRenames } from './propagate.js';
import { checkRulesFile, formatFields, lockProblems, plain, signatureOf, withMeta, type RulesCheck } from './rules.js';
import { commitSource, planName, planSource, settleSource } from './sourceResolve.js';
import { applySource, mergeFromEdit, structureOfDoc, withSourceAliases } from './sourceLogic.js';
import { addSourceAlias, formatNamesOf, registerSourceRoutes } from './sourceRoutes.js';
import { countSourceFormats, isDuplicateKey, propagateSource, renameSource, syncRequired, takenSourceNames, writeSourceVersion } from './sourceStore.js';

export interface RegisterRegistryRoutesOptions {
  /** Null when no database is configured: every route then answers 503 `unavailable`. */
  db: AppDb | null;
  protection: Protection;
  /** Tests: who is calling (default: `identityOf`). */
  identify?: (req: FastifyRequest) => Identity;
}

/** How a rules file that failed `checkRulesFile` is answered. */
function rulesRefusal(reply: FastifyReply, checked: Extract<RulesCheck, { ok: false }>): FastifyReply {
  if (checked.onlyRuleLimit) return fail(reply, 403, { error: 'limitHit', limit: 'rulesPerFormat' });
  return fail(reply, 422, { error: 'invalidRules', problems: checked.problems });
}

export function registerRegistryRoutes(app: FastifyInstance, opts: RegisterRegistryRoutesOptions): void {
  const ctx = createRegistryContext(opts);
  const { protection, guard, idParam, ownedFormat, ownedConversion, ownedSource } = ctx;

  registerSourceRoutes(app, ctx);

  const statsOf = async (d: AppDb, c: Caller, formatId: ObjectId): Promise<SourceStats> =>
    aggregateSources(
      await d.conversions
        .find({ ownerId: c.ownerId, formatId }, { projection: { status: 1, runCount: 1, lastRunAt: 1 } })
        .toArray(),
    );

  const sourcesAllowed = async (d: AppDb, c: Caller, formatId: ObjectId): Promise<boolean> => {
    const cap = tiers[c.tier].sourcesPerFormat;
    if (cap === 'unlimited') return true;
    return (await d.conversions.countDocuments({ ownerId: c.ownerId, formatId })) < cap;
  };

  /** Source id (hex) -> the source's name, for the conversions' summaries (SPEC 13: the source's own name is the only name). */
  const sourceNames = async (d: AppDb, c: Caller, docs: readonly Pick<ConversionDoc, 'sourceId'>[]): Promise<Map<string, string>> => {
    const ids = [...new Map(docs.map((x) => [x.sourceId.toHexString(), x.sourceId] as const)).values()];
    if (ids.length === 0) return new Map();
    const found = await d.sources.find({ ownerId: c.ownerId, _id: { $in: ids } }, { projection: { name: 1 } }).toArray();
    return new Map(found.map((s) => [s._id!.toHexString(), s.name] as const));
  };
  const nameOf = (names: ReadonlyMap<string, string>, doc: Pick<ConversionDoc, 'sourceId'>): string => names.get(doc.sourceId.toHexString()) ?? '';

  /** The conversion's source: every conversion has one, so null means the data is broken (the route answers 404). */
  const sourceOfConversion = (d: AppDb, c: Caller, conv: Pick<ConversionDoc, 'sourceId'>): Promise<SourceDoc | null> => ownedSource(d, c, conv.sourceId);

  // ---------------------------------------------------------------- formats

  app.post('/api/formats', async (req, reply) => {
    const g = guard(req, reply);
    if (!g) return reply;
    const { db: d, caller } = g;

    const body = isRecord(req.body) ? req.body : null;
    const name = body ? parseName(body.name) : null;
    const fields = body ? parseSaveFields(body) : null;
    const choice = body ? parseSourceChoice(body) : null;
    if (!body || !name || !fields || !choice) return fail(reply, 400, { error: 'invalidRequest' });

    const now = protection.now();
    const formatId = new ObjectId();
    const metaFor = (sourceName: string) => ({ ...fields, name, formatId: formatId.toHexString(), sourceName, now });
    const checked = checkRulesFile(withMeta(fields.rules, metaFor(choice.newSourceName ?? choice.sourceName ?? 'Source 1')), caller.tier);
    if (!checked.ok) return rulesRefusal(reply, checked);

    // SPEC 11: saved formats (delete frees a slot), sources per format, and DECISION 9: paid = N NEW formats a month.
    const tier = tiers[caller.tier];
    if (
      typeof tier.savedFormats === 'number' &&
      (await d.formats.countDocuments({ ownerId: caller.ownerId })) >= tier.savedFormats
    ) {
      return fail(reply, 403, { error: 'limitHit', limit: 'savedFormats' });
    }
    if (tier.sourcesPerFormat === 0) return fail(reply, 403, { error: 'limitHit', limit: 'sourcesPerFormat' });

    // SPEC 8.15 "Saving": the source this conversion reads - an existing one that matches, or a new one.
    const planned = await planSource(d, caller.ownerId, { rules: checked.rules, choice });
    if (!planned.ok) return fail(reply, planned.status, planned.body);
    const sourceName = planName(planned.plan);
    const final = checkRulesFile(withMeta(planned.rules, metaFor(sourceName)), caller.tier);
    if (!final.ok) return rulesRefusal(reply, final);
    const rules = final.rules;

    let monthly: { key: string } | null = null;
    if (tier.newSavedFormatsPerMonth !== undefined) {
      const key = newFormatsKey(caller.ownerId.toHexString(), now);
      const reservation = await reserveLearn(protection.store, [
        { key, limit: tier.newSavedFormatsPerMonth, limitCode: 'newFormatsPerMonth' },
      ]);
      if (!reservation.ok) return fail(reply, 429, { error: 'limitHit', limit: 'newFormatsPerMonth' });
      monthly = { key };
    }
    const refund = async (): Promise<void> => {
      if (monthly) await protection.store.incrementCounter(monthly.key, -1).catch(() => undefined);
    };

    const committed = await commitSource(d, caller.ownerId, planned.plan, rules, now);
    if (!committed.ok) {
      await refund();
      return fail(reply, committed.status, committed.body);
    }
    const source = committed.source;

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
      sourceId: source.id,
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
      if (source.created) await d.sources.deleteOne({ _id: source.id, ownerId: caller.ownerId }).catch(() => undefined);
      await refund();
      throw err;
    }
    await settleSource(d, caller.ownerId, source.id, planned.plan, now, choice.inputHeaders);

    const response: CreateFormatResponse = {
      format: formatSummary(formatDoc, aggregateSources([conversionDoc])),
      conversion: conversionSummary(conversionDoc, sourceName),
      source: { id: source.id.toHexString(), name: sourceName, formats: await countSourceFormats(d, caller.ownerId, source.id) },
      ...(source.reused ? { sourceReused: { id: source.id.toHexString(), name: sourceName } } : {}),
    };
    return reply.code(201).send(response);
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
    const names = await sourceNames(d, caller, conversions);
    return reply.send({
      format: formatDetail(format, aggregateSources(conversions)),
      conversions: conversions.map((c) => conversionSummary(c, nameOf(names, c))),
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
    // Deleting frees a saved-format slot and never refunds AI learns or this month's new-format count. The sources it was fed by stay
    // (SPEC 8.15: they are the company's, and may feed other formats - or a format learned later).
    const doomed = await d.conversions.find({ ownerId: caller.ownerId, formatId: format._id! }, { projection: { sourceId: 1 } }).toArray();
    const removed = await d.conversions.deleteMany({ ownerId: caller.ownerId, formatId: format._id! });
    await d.formats.deleteOne({ _id: format._id!, ownerId: caller.ownerId });
    for (const id of new Map(doomed.map((c) => [c.sourceId.toHexString(), c.sourceId] as const)).values()) {
      await syncRequired(d, caller.ownerId, id);
    }
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
    const choice = body ? parseSourceChoice(body) : null;
    if (!body || !fields || !choice) return fail(reply, 400, { error: 'invalidRequest' });

    const formatId = format._id!;
    if (!(await sourcesAllowed(d, caller, formatId))) return fail(reply, 403, { error: 'limitHit', limit: 'sourcesPerFormat' });

    const now = protection.now();
    const metaFor = (sourceName: string) => ({ ...fields, name: format.name, formatId: formatId.toHexString(), sourceName, now });
    const checked = checkRulesFile(withMeta(fields.rules, metaFor(choice.newSourceName ?? choice.sourceName ?? 'Source')), caller.tier);
    if (!checked.ok) return rulesRefusal(reply, checked);

    // SPEC 8.12: the output side must equal the format's (except `from`), else say which columns differ.
    const mismatch = lockProblems(checked.rules, formatOfDoc(format));
    if (mismatch.length > 0) return fail(reply, 422, { error: 'formatMismatch', problems: mismatch });

    // SPEC 8.15 "Saving": reuse the source the example input matches, or make a new one - and the source lock holds either way.
    const planned = await planSource(d, caller.ownerId, {
      rules: checked.rules,
      choice,
      feedsFormat: async (sourceId) => (await d.conversions.countDocuments({ ownerId: caller.ownerId, sourceId, formatId })) > 0,
    });
    if (!planned.ok) return fail(reply, planned.status, planned.body);
    const sourceName = planName(planned.plan);
    const final = checkRulesFile(withMeta(planned.rules, metaFor(sourceName)), caller.tier);
    if (!final.ok) return rulesRefusal(reply, final);
    const rules = final.rules;

    const committed = await commitSource(d, caller.ownerId, planned.plan, rules, now);
    if (!committed.ok) return fail(reply, committed.status, committed.body);
    const source = committed.source;

    const doc: ConversionDoc = {
      _id: new ObjectId(),
      ownerId: caller.ownerId,
      formatId,
      sourceId: source.id,
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
      await d.conversions.insertOne(doc);
    } catch (err) {
      if (source.created) await d.sources.deleteOne({ _id: source.id, ownerId: caller.ownerId }).catch(() => undefined);
      throw err;
    }
    await settleSource(d, caller.ownerId, source.id, planned.plan, now, choice.inputHeaders);

    const response: AttachSourceResponse = {
      conversion: conversionSummary(doc, sourceName),
      source: { id: source.id.toHexString(), name: sourceName, formats: await countSourceFormats(d, caller.ownerId, source.id) },
      ...(source.reused ? { sourceReused: { id: source.id.toHexString(), name: sourceName } } : {}),
    };
    return reply.code(201).send(response);
  });

  // ------------------------------------------------------- conversions

  app.get('/api/conversions/:id', async (req, reply) => {
    const g = guard(req, reply);
    if (!g) return reply;
    const conversion = await ownedConversion(g.db, g.caller, idParam(req));
    if (!conversion) return fail(reply, 404, { error: 'notFound' });
    const source = await sourceOfConversion(g.db, g.caller, conversion);
    if (!source) return fail(reply, 404, { error: 'notFound' });
    return reply.send({ conversion: conversionDetail(conversion, source.name, await countSourceFormats(g.db, g.caller.ownerId, source._id!)) });
  });

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
    const source = await sourceOfConversion(d, caller, conv);
    if (!source) return fail(reply, 404, { error: 'notFound' });
    const currentName = source.name;

    // ---- a new name for the conversion's source (SPEC 8.15: names belong to sources, unique among the caller's) ----
    let sourceName = currentName;
    if (update.sourceName !== undefined) {
      if (nameKey(update.sourceName) !== nameKey(currentName)) {
        const taken = await takenSourceNames(d, caller.ownerId, source._id!);
        if (taken.some((t) => nameKey(t) === nameKey(update.sourceName!))) return fail(reply, 409, { error: 'nameTaken' });
      }
      sourceName = update.sourceName;
    }
    const renamed = sourceName !== currentName;
    const rename = async (): Promise<FastifyReply | null> => {
      if (!renamed) return null;
      try {
        await renameSource(d, caller.ownerId, source, sourceName, now);
      } catch (e) {
        if (isDuplicateKey(e)) return fail(reply, 409, { error: 'nameTaken' });
        throw e;
      }
      return null;
    };

    // ---- a rename only: not a new version of the rules, but the copy of the name inside them follows ----
    if (!update.save) {
      const refused = await rename();
      if (refused) return refused;
      if (!renamed) await d.conversions.updateOne({ _id: conv._id!, ownerId: caller.ownerId }, { $set: { updatedAt: now } });
      const body: UpdateConversionResponse = {
        conversion: conversionSummary({ ...conv, updatedAt: now }, sourceName),
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
    let rules = checked.rules;

    // SPEC 8.15: an edit that changes the input side changes the SOURCE, for every format it feeds (like a format edit): the source
    // takes the change, this conversion is brought to the source (aliases the source has and it doesn't), and the others follow below.
    let sourceEdit: { structure: SourceStructure; renames: Map<string, string> } | null = null;
    const structure = structureOfDoc(source);
    if (checkSourceLock(rules, structure).length > 0) {
      const merge = mergeFromEdit(structure, rules, before);
      const applied = applySource(rules, merge.structure);
      if (applied.needsReview) return fail(reply, 422, { error: 'sourceMismatch', problems: applied.problems });
      rules = applied.rules;
      if (!deepEqual(merge.structure, structure)) sourceEdit = merge;
    }

    // SPEC 8.12: an edit that changes the output side changes the FORMAT, for all its sources.
    const formatChanged = checkFormatLock(rules, formatOfDoc(format)).length > 0;

    const refused = await rename();
    if (refused) return refused;

    const next = conversionWrite(
      conv,
      {
        rules,
        status: save.status,
        acceptedDifferences: save.acceptedDifferences,
        exampleExceptions: save.exampleExceptions ?? conv.exampleExceptions,
      },
      now,
    );
    if (!(await saveVersion(d, caller.ownerId, conv, next))) return fail(reply, 409, { error: 'versionConflict' });

    /** Gives the conversion back as it was, so it never disagrees with a format or source that didn't take the change. */
    const revertConversion = async (): Promise<void> => {
      await d.conversions.updateOne(
        { _id: conv._id!, ownerId: caller.ownerId, version: next.version },
        {
          $set: {
            rules: conv.rules,
            inputSignature: conv.inputSignature,
            status: conv.status,
            acceptedDifferences: conv.acceptedDifferences,
            exampleExceptions: conv.exampleExceptions,
            version: conv.version,
            updatedAt: conv.updatedAt,
          },
          $pop: { versions: 1 },
        },
      );
    };

    let writtenSource: SourceDoc | null = null;
    if (sourceEdit) {
      writtenSource = await writeSourceVersion(d, caller.ownerId, source, sourceEdit.structure, now);
      if (!writtenSource) {
        await revertConversion();
        return fail(reply, 409, { error: 'versionConflict' });
      }
    }

    const affected: NonNullable<UpdateConversionResponse['needsReview']> = [];
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
              $slice: -versionCap(),
            },
          },
        },
      );
      if (applied.matchedCount === 0) {
        // Someone changed the format meanwhile: give this conversion (and the source) back, so nothing disagrees with the format.
        await revertConversion();
        if (writtenSource) {
          await d.sources.updateOne(
            { _id: source._id!, ownerId: caller.ownerId, version: writtenSource.version },
            {
              $set: {
                inputSignature: source.inputSignature,
                inputReading: source.inputReading,
                inputValidations: source.inputValidations,
                version: source.version,
                updatedAt: source.updatedAt,
              },
              $pop: { versions: 1 },
            },
          );
        }
        return fail(reply, 409, { error: 'versionConflict' });
      }

      // Every other source of the format takes the new output side (SPEC 8.12 "Editing a format").
      const newFormat = formatOfDoc(changed);
      const renames = headerRenames(before, rules);
      const siblings = await d.conversions
        .find({ ownerId: caller.ownerId, formatId: format._id!, _id: { $ne: conv._id! } })
        .toArray();
      others = siblings.length;
      const siblingSources = await sourceNames(d, caller, siblings);
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
              { rules: rewritten, status, acceptedDifferences: cur.acceptedDifferences, exampleExceptions: cur.exampleExceptions },
              now,
            );
          } else {
            // Stored rules that no longer parse cannot be rebuilt: leave them, flagged for review.
            written = { ...cur, status: 'needsReview', version: cur.version + 1, updatedAt: now };
          }
          if (await saveVersion(d, caller.ownerId, cur, written)) {
            if (written.status === 'needsReview') {
              affected.push({ id: cur._id!.toHexString(), sourceName: nameOf(siblingSources, cur), formatId: format._id!.toHexString(), formatName: format.name });
            }
            break;
          }
        }
      }
    }

    // SPEC 8.15 "Editing a source": the other conversions of the source take the input side, whatever format they feed.
    let affectedConversions = 0;
    if (writtenSource && sourceEdit) {
      const propagated = await propagateSource(d, caller.ownerId, writtenSource._id!, sourceEdit.structure, sourceEdit.renames, now, { except: conv._id! });
      affectedConversions = propagated.conversions;
      const names = await formatNamesOf(d, caller.ownerId, propagated.needsReview);
      for (const f of propagated.needsReview) {
        if (affected.some((a) => a.id === f.id.toHexString())) continue;
        affected.push({ id: f.id.toHexString(), sourceName, formatId: f.formatId.toHexString(), formatName: names.get(f.formatId.toHexString()) ?? '' });
      }
    }
    await syncRequired(d, caller.ownerId, source._id!);

    const body: UpdateConversionResponse = {
      conversion: conversionSummary(next, sourceName),
      formatChanged,
      affectedSources: others,
      needsReview: affected,
      ...(sourceEdit ? { sourceChanged: true, affectedConversions } : {}),
    };
    return reply.send(body);
  });

  app.delete('/api/conversions/:id', async (req, reply) => {
    const g = guard(req, reply);
    if (!g) return reply;
    const conversion = await ownedConversion(g.db, g.caller, idParam(req));
    if (!conversion) return fail(reply, 404, { error: 'notFound' });
    // The format stays, even with no sources left (a format need not have been learned, SPEC 8.12); so does the source (SPEC 8.15:
    // it is the company's, and may feed other formats; it can be deleted through `DELETE /api/sources/:id` once it feeds none).
    await g.db.conversions.deleteOne({ _id: conversion._id!, ownerId: g.caller.ownerId });
    await syncRequired(g.db, g.caller.ownerId, conversion.sourceId);
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
    const source = await sourceOfConversion(d, caller, conv);
    if (!source) return fail(reply, 404, { error: 'notFound' });

    const now = protection.now();
    const oldMeta = isRecord(old.rules) && isRecord(old.rules.meta) ? old.rules.meta : {};
    const checked = checkRulesFile(
      withMeta(old.rules, {
        name: (conv.rules as Rules).name,
        formatId: format._id!.toHexString(),
        sourceName: source.name,
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

    // The same for the source lock (SPEC 8.15) - except its aliases: they are what the source has learned since, not how the rules
    // behave, so the version comes back with the source's.
    const structure = structureOfDoc(source);
    const restored = withSourceAliases(checked.rules, structure);
    const sourceProblems = checkSourceLock(restored, structure);
    if (sourceProblems.length > 0) return fail(reply, 422, { error: 'sourceMismatch', problems: sourceProblems });

    const next = conversionWrite(
      conv,
      {
        rules: restored,
        status: old.status,
        acceptedDifferences: old.acceptedDifferences,
        exampleExceptions: conv.exampleExceptions,
      },
      now,
    );
    if (!(await saveVersion(d, caller.ownerId, conv, next))) return fail(reply, 409, { error: 'versionConflict' });
    await syncRequired(d, caller.ownerId, source._id!);
    return reply.send({ conversion: conversionSummary(next, source.name) });
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

    // DECISION: kept working for the web app as it was, and forwarded to the conversion's SOURCE (SPEC 8.15: a confirmed mapping is
    // saved once, on the source, and reaches every format it feeds). The answer is still this conversion's signature.
    const source = await sourceOfConversion(d, caller, conv);
    if (!source) return fail(reply, 404, { error: 'notFound' });
    const parsed = RulesSchema.safeParse(conv.rules);
    if (!parsed.success) return fail(reply, 422, { error: 'invalidRules' });
    if (!(parsed.data as unknown as Rules).input.columns.some((c) => c.header === request.header)) return fail(reply, 400, { error: 'invalidRequest' });
    const res = await addSourceAlias(d, caller.ownerId, source, request, protection.now());
    if (!res.ok) return fail(reply, res.status, res.body);
    await syncRequired(d, caller.ownerId, source._id!);
    const fresh = await d.conversions.findOne({ _id: conv._id!, ownerId: caller.ownerId }, { projection: { inputSignature: 1 } });
    return reply.send({ inputSignature: fresh?.inputSignature ?? conv.inputSignature });
  });

  // ------------------------------------------------------- signatures

  app.get('/api/signatures', async (req, reply) => {
    const g = guard(req, reply);
    if (!g) return reply;
    const { db: d, caller } = g;

    const [sources, conversions] = await Promise.all([
      d.sources.find({ ownerId: caller.ownerId }).sort({ createdAt: 1, _id: 1 }).toArray(),
      d.conversions
        .find({ ownerId: caller.ownerId }, { projection: { formatId: 1, sourceId: 1, status: 1 } })
        .sort({ createdAt: 1, _id: 1 })
        .toArray(),
    ]);
    const formatNames = await formatNamesOf(d, caller.ownerId, conversions);
    const bySource = new Map<string, typeof conversions>();
    for (const c of conversions) {
      const key = c.sourceId.toHexString();
      const list = bySource.get(key);
      if (list) list.push(c);
      else bySource.set(key, [c]);
    }
    // One entry per SOURCE (SPEC 8.15): what matching reads, and the formats it feeds.
    const signatures: SignatureEntry[] = sources.map((s) => signatureEntry(s, bySource.get(s._id!.toHexString()) ?? [], formatNames));
    return reply.send({ signatures });
  });
}
