// The admin audit log (SPEC 13 `admin_audit`, 14.2): every change an admin makes through the admin routes is written here - who, when, what.
// It is append-only: nothing in the API edits or deletes a row. Ids and the changed values only; the names shown in the list are read from
// the target when the list is built.
import type { AdminAuditEntry } from '@formatai/shared';
import { limits } from '@formatai/shared';
import type { ObjectId } from 'mongodb';
import type { AppDb } from '../db.js';
import type { AdminAuditDoc } from '../models.js';
import { primaryEmail } from './users.js';

export type AuditChange = Pick<AdminAuditDoc, 'action' | 'targetKind' | 'targetId' | 'before' | 'after'>;

/** The admin as the log names her: her id, and her own email as it is now. */
export interface AuditActor {
  id: ObjectId;
  email?: string;
}

export async function actorOf(db: AppDb, id: ObjectId): Promise<AuditActor> {
  const user = await db.users.findOne({ _id: id }, { projection: { identities: 1 } });
  const email = user ? primaryEmail(user) : undefined;
  return { id, ...(email ? { email } : {}) };
}

/** Writes the log lines of one change; returns their ids (so a change that then fails can take its lines back). */
export async function recordChanges(db: AppDb, actor: AuditActor, changes: readonly AuditChange[], at: Date): Promise<ObjectId[]> {
  if (changes.length === 0) return [];
  const res = await db.adminAudit.insertMany(
    changes.map((c) => ({ ts: at, adminId: actor.id, ...(actor.email ? { adminEmail: actor.email } : {}), ...c })),
  );
  return Object.values(res.insertedIds);
}

export async function undoRecorded(db: AppDb, ids: readonly ObjectId[]): Promise<void> {
  if (ids.length > 0) await db.adminAudit.deleteMany({ _id: { $in: [...ids] } });
}

/** The newest lines, newest first, with the target's name read now (null once it is gone). */
export async function listAudit(db: AppDb): Promise<AdminAuditEntry[]> {
  const docs = await db.adminAudit.find({}).sort({ ts: -1, _id: -1 }).limit(limits.admin.auditListed).toArray();
  const targets = (kind: AdminAuditDoc['targetKind']): ObjectId[] => docs.filter((d) => d.targetKind === kind).map((d) => d.targetId);
  const userIds = targets('user');
  const requestIds = targets('functionRequest');
  const [users, requests] = await Promise.all([
    userIds.length === 0 ? [] : db.users.find({ _id: { $in: userIds } }, { projection: { identities: 1, name: 1 } }).toArray(),
    requestIds.length === 0 ? [] : db.functionRequests.find({ _id: { $in: requestIds } }, { projection: { name: 1 } }).toArray(),
  ]);
  const labels = new Map<string, string>([
    ...users.map((u) => [u._id.toHexString(), primaryEmail(u) ?? u.name ?? ''] as const),
    ...requests.map((r) => [r._id.toHexString(), r.name] as const),
  ]);
  return docs.map((d) => ({
    id: d._id!.toHexString(),
    ts: d.ts.toISOString(),
    adminId: d.adminId.toHexString(),
    adminEmail: d.adminEmail ?? null,
    action: d.action,
    targetKind: d.targetKind,
    targetId: d.targetId.toHexString(),
    targetLabel: labels.get(d.targetId.toHexString()) || null,
    before: d.before,
    after: d.after,
  }));
}
