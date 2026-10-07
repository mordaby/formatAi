// The small helpers every route file used to write for itself (API audit 2026-10-07: one of each): how a refusal is sent, and the
// one shape check request bodies start from. The per-IP request limit is `limitByIp` (protection/rateLimit.ts).
import type { ApiErrorBody } from '@formatai/shared';
import type { FastifyReply } from 'fastify';

/** Sends a refusal: the status and the stable error body (`{ error, ... }`, shared `API_ERROR_CODES`; the web maps it to text). */
export function fail(reply: FastifyReply, status: number, body: ApiErrorBody): FastifyReply {
  return reply.code(status).send(body);
}

/** A plain object (not null, not an array): what a JSON body or a part of one must be before its fields are read. */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
