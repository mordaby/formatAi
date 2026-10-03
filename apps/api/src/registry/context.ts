// What every registry route needs and would otherwise repeat: who is calling, ownership-checked reads, the way a refusal is
// sent. Shared by `routes.ts` (formats and conversions) and `sourceRoutes.ts` (sources, SPEC 8.15).
import type { ApiErrorBody, Tier } from '@formatai/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ObjectId } from 'mongodb';
import type { AppDb } from '../db.js';
import type { ConversionDoc, FormatDoc, SourceDoc } from '../models.js';
import { identityOf, type Identity } from '../protection/identity.js';
import type { Protection } from '../protection/index.js';
import { objectIdOf } from './ids.js';

export interface Caller {
  ownerId: ObjectId;
  tier: Tier;
}

export interface RegistryContext {
  protection: Protection;
  /** Signed in (401), database there (503): the caller and the database, or null with the reply sent. */
  guard(req: FastifyRequest, reply: FastifyReply): { db: AppDb; caller: Caller } | null;
  idParam(req: FastifyRequest, name?: string): ObjectId | undefined;
  ownedFormat(d: AppDb, c: Caller, id: ObjectId | undefined): Promise<FormatDoc | null>;
  ownedConversion(d: AppDb, c: Caller, id: ObjectId | undefined): Promise<ConversionDoc | null>;
  ownedSource(d: AppDb, c: Caller, id: ObjectId | undefined): Promise<SourceDoc | null>;
}

export interface RegistryContextOptions {
  /** Null when no database is configured: every route then answers 503 `unavailable`. */
  db: AppDb | null;
  protection: Protection;
  /** Tests: who is calling (default: `identityOf`). */
  identify?: (req: FastifyRequest) => Identity;
}

export function fail(reply: FastifyReply, status: number, body: ApiErrorBody): FastifyReply {
  return reply.code(status).send(body);
}

export function createRegistryContext(opts: RegistryContextOptions): RegistryContext {
  const { db, protection } = opts;
  const identify = opts.identify ?? identityOf;
  return {
    protection,
    guard(req, reply) {
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
    },
    idParam: (req, name = 'id') => objectIdOf((req.params as Record<string, string | undefined>)[name]),
    ownedFormat: async (d, c, id) => (id ? d.formats.findOne({ _id: id, ownerId: c.ownerId }) : null),
    ownedConversion: async (d, c, id) => (id ? d.conversions.findOne({ _id: id, ownerId: c.ownerId }) : null),
    ownedSource: async (d, c, id) => (id ? d.sources.findOne({ _id: id, ownerId: c.ownerId }) : null),
  };
}
