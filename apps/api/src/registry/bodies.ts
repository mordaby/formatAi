// Request-body validators for the registry routes. Hand-written (this package has no schema library of its
// own): each returns the typed value, or null when the body is not what the route takes - the route answers
// `invalidRequest`, which never says what was wrong (SPEC 15).
import {
  limits,
  RULES_META_LEARN_PATHS,
  RULES_META_SOURCES,
  UpdateSourceBodySchema,
  type RulesMetaLearnPath,
  type RulesMetaSource,
  type UpdateSourceRequest,
} from '@formatai/shared';
import type { ObjectId } from 'mongodb';
import { objectIdOf } from './ids.js';

/** The statuses a client may set: `needsReview` is set only by the server (SPEC 8.12). */
export const SAVABLE_STATUSES = ['verified', 'differencesAccepted', 'userConfirmed', 'draft'] as const;
export type SavableStatus = (typeof SAVABLE_STATUSES)[number];

const MAX_COUNT = 10_000_000;
const MAX_SHORT_TEXT = 100;

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A name a user typed (format, source): trimmed, 1..`maxNameChars`, no control characters. */
export function parseName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const name = v.trim();
  if (name.length === 0 || name.length > limits.registry.maxNameChars) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return null;
  return name;
}

/** How names are compared for "another source already has that name": case- and space-insensitive. */
export const nameKey = (name: string): string => name.trim().replace(/\s+/g, ' ').toLocaleLowerCase();

function parseCount(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_COUNT ? v : null;
}

function parseShortText(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_SHORT_TEXT ? v : null;
}

export interface SaveFields {
  rules: Record<string, unknown>;
  status: SavableStatus;
  acceptedDifferences: number;
  exampleExceptions: number[];
  learnPath: RulesMetaLearnPath;
  masking: boolean;
  model?: string;
  promptVersion?: string;
  source: RulesMetaSource;
}

/** Row numbers, sorted and without repeats. */
function parseExceptions(v: unknown): number[] | null {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > limits.registry.maxExampleExceptions) return null;
  const rows = new Set<number>();
  for (const item of v) {
    const n = parseCount(item);
    if (n === null) return null;
    rows.add(n);
  }
  return [...rows].sort((a, b) => a - b);
}

/** The fields of a "save this learned result" body (POST /api/formats and .../conversions). */
export function parseSaveFields(body: Record<string, unknown>): SaveFields | null {
  if (!isRecord(body.rules)) return null;
  if (!(SAVABLE_STATUSES as readonly unknown[]).includes(body.status)) return null;
  const status = body.status as SavableStatus;
  if (!(RULES_META_LEARN_PATHS as readonly unknown[]).includes(body.learnPath)) return null;
  if (typeof body.masking !== 'boolean') return null;

  const accepted = body.acceptedDifferences === undefined ? 0 : parseCount(body.acceptedDifferences);
  const exampleExceptions = parseExceptions(body.exampleExceptions);
  if (accepted === null || exampleExceptions === null) return null;

  const source = body.source === undefined ? 'examplePair' : body.source;
  if (!(RULES_META_SOURCES as readonly unknown[]).includes(source)) return null;

  const fields: SaveFields = {
    rules: body.rules,
    status,
    // Only "saved with N differences" has any.
    acceptedDifferences: status === 'differencesAccepted' ? accepted : 0,
    exampleExceptions,
    learnPath: body.learnPath as RulesMetaLearnPath,
    masking: body.masking,
    source: source as RulesMetaSource,
  };
  if (body.model !== undefined) {
    const model = parseShortText(body.model);
    if (model === null) return null;
    fields.model = model;
  }
  if (body.promptVersion !== undefined) {
    const promptVersion = parseShortText(body.promptVersion);
    if (promptVersion === null) return null;
    fields.promptVersion = promptVersion;
  }
  return fields;
}

export interface UpdateFields {
  sourceName?: string;
  /** Present when the body saves rules; then `status` and the counts are set too. */
  save?: { rules: Record<string, unknown>; status: SavableStatus; acceptedDifferences: number; exampleExceptions?: number[] };
  baseVersion?: number;
}

/** PATCH /api/conversions/:id: a rename, a rules save, or both. */
export function parseUpdateFields(body: Record<string, unknown>): UpdateFields | null {
  const out: UpdateFields = {};
  if (body.sourceName !== undefined) {
    const name = parseName(body.sourceName);
    if (name === null) return null;
    out.sourceName = name;
  }
  if (body.baseVersion !== undefined) {
    if (typeof body.baseVersion !== 'number' || !Number.isInteger(body.baseVersion) || body.baseVersion < 1) return null;
    out.baseVersion = body.baseVersion;
  }
  if (body.rules !== undefined) {
    if (!isRecord(body.rules)) return null;
    if (!(SAVABLE_STATUSES as readonly unknown[]).includes(body.status)) return null;
    const status = body.status as SavableStatus;
    const accepted = body.acceptedDifferences === undefined ? 0 : parseCount(body.acceptedDifferences);
    if (accepted === null) return null;
    const save: NonNullable<UpdateFields['save']> = {
      rules: body.rules,
      status,
      acceptedDifferences: status === 'differencesAccepted' ? accepted : 0,
    };
    if (body.exampleExceptions !== undefined) {
      const exceptions = parseExceptions(body.exampleExceptions);
      if (exceptions === null) return null;
      save.exampleExceptions = exceptions;
    }
    out.save = save;
  } else if (body.status !== undefined || body.acceptedDifferences !== undefined || body.exampleExceptions !== undefined) {
    // Status and counts describe a rules save; on their own they would let a client mark anything verified.
    return null;
  }
  return out.sourceName === undefined && out.save === undefined ? null : out;
}

export function parseRun(body: Record<string, unknown>): { rows: number; flagged: number } | null {
  const rows = parseCount(body.rows);
  const flagged = parseCount(body.flagged);
  return rows === null || flagged === null ? null : { rows, flagged };
}

export function parseAlias(body: Record<string, unknown>): { header: string; alias: string } | null {
  const header = body.header;
  if (typeof header !== 'string' || header.length === 0 || header.length > limits.registry.maxAliasChars) return null;
  if (typeof body.alias !== 'string') return null;
  const alias = body.alias.trim();
  if (alias.length === 0 || alias.length > limits.registry.maxAliasChars) return null;
  return { header, alias };
}

/** Which source a save belongs to (POST /api/formats and .../conversions; SPEC 8.15 "Saving"). */
export interface SourceChoiceFields {
  /** Use this existing source (explicit). */
  sourceId?: ObjectId;
  /** Create a new source with this name, never reuse (explicit). */
  newSourceName?: string;
  /** Headers of the example input, to match against the owner's sources. */
  inputHeaders?: string[];
  /** The name for the source the server creates when nothing matched (none: the server picks "Source N"). */
  sourceName?: string;
}

/**
 * `sourceId`, `newSource`, `inputHeaders` and `sourceName` (all optional). Null for a body that names both a source and a
 * new source, or anything malformed. Over-long headers are left out of `inputHeaders` rather than failing the save: they can't
 * match anything worth matching, and the save must not depend on them.
 */
export function parseSourceChoice(body: Record<string, unknown>): SourceChoiceFields | null {
  const out: SourceChoiceFields = {};
  if (body.sourceId !== undefined) {
    const id = objectIdOf(body.sourceId);
    if (!id) return null;
    out.sourceId = id;
  }
  if (body.newSource !== undefined) {
    if (!isRecord(body.newSource)) return null;
    const name = parseName(body.newSource.name);
    if (name === null) return null;
    out.newSourceName = name;
  }
  if (out.sourceId && out.newSourceName) return null;
  if (body.sourceName !== undefined) {
    const name = parseName(body.sourceName);
    if (name === null) return null;
    out.sourceName = name;
  }
  if (body.inputHeaders !== undefined) {
    if (!Array.isArray(body.inputHeaders) || body.inputHeaders.length > limits.registry.maxInputHeaders) return null;
    const headers: string[] = [];
    for (const h of body.inputHeaders) {
      if (typeof h !== 'string') return null;
      if (h.length <= limits.registry.maxAliasChars) headers.push(h);
    }
    out.inputHeaders = headers;
  }
  return out;
}

export interface SourceUpdateFields extends Omit<UpdateSourceRequest, 'name'> {
  name?: string;
}

/** PATCH /api/sources/:id: a rename, an edit of the structure, or both. Null when the body is not one of those. */
export function parseSourceUpdate(body: Record<string, unknown>): SourceUpdateFields | null {
  const parsed = UpdateSourceBodySchema.safeParse(body);
  if (!parsed.success) return null;
  const { name, ...rest } = parsed.data;
  const out: SourceUpdateFields = { ...(rest as Omit<UpdateSourceRequest, 'name'>) };
  if (name !== undefined) {
    const n = parseName(name);
    if (n === null) return null;
    out.name = n;
  }
  // A version to compare with only makes sense next to an edit.
  const edits = out.name !== undefined || out.inputSignature !== undefined || out.inputReading !== undefined || out.inputValidations !== undefined;
  return edits ? out : null;
}
