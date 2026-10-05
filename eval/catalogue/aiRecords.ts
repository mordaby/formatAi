// The pure side of the AI measurement (no engine, no API, no LLM): which types need the AI step, how the needs-AI set is split into
// chunks, which (type, seed) pairs `--resume` skips, how records are merged into results.json, and what an AI record counts as.
// The measurement itself (it calls the real learn flow) is ai.ts.
import { sumEstimates, type TokenEstimate } from '@formatai/shared';
import type { Chunk } from './args';
import type { AiConfigRecord, AiRecord, CatalogueRecord, CatalogueType } from './types';

// ---------- What an AI record counts as ----------

/** learned = verified on the example AND the next month's file converts exactly; verifiedOnly = verified on the example, not on the next file;
 * failed = not verified (wrong, unsupported columns, no rules, never reached the AI step ...); error = the measurement itself failed (not an answer). */
export type AiStatus = 'learned' | 'verifiedOnly' | 'failed' | 'error';

export function aiStatusOf(a: AiRecord): AiStatus {
  if (a.error !== undefined) return 'error';
  if (!a.verified) return 'failed';
  return a.holdOut === 'pass' ? 'learned' : 'verifiedOnly';
}

/** Which measurements belong together: the same model, mode, masking and escalation setting. (The provider is how the model is reached, not what is measured.) */
export function aiConfigKey(c: Pick<AiConfigRecord, 'model' | 'mode' | 'masking' | 'noEscalation'>): string {
  return `${c.model} / ${c.mode} / masking ${c.masking ? 'on' : 'off'} / escalation ${c.noEscalation ? 'off' : 'on'}`;
}

export function sameAiConfig(a: AiConfigRecord, b: AiConfigRecord): boolean {
  return aiConfigKey(a) === aiConfigKey(b);
}

// ---------- Our own token estimate ----------

/** The estimates of the records that carry one (a record measured before the estimate existed has none), added up, and how many records that is.
 * The cost is null as soon as one of them has no price. A mean per record is the total over `records`. */
export function estimateTotals(records: readonly AiRecord[]): { records: number; total: TokenEstimate } {
  const have = records.flatMap((a) => (a.estimate ? [a.estimate] : []));
  return { records: have.length, total: sumEstimates(have) };
}

// ---------- The needs-AI set ----------

/** The language can express the type (the reference rule is valid and reproduces the expected output) and the free engine does not solve it on every
 * seed (partial, nothing, or wrong: overfit / unverified). Same definition as the report's "Expressible, needs AI". */
export function needsAi(records: readonly CatalogueRecord[]): boolean {
  if (records.length === 0) return false;
  if (!records.every((r) => r.language.expressible && r.language.valid === true && r.language.reproduces === true)) return false;
  return records.some((r) => r.fast.status !== 'solved');
}

/** The types of `types` (catalogue order kept) that need the AI step, judged on their free records. A type with no free record is not decided here. */
export function needsAiTypes(types: readonly CatalogueType[], records: readonly CatalogueRecord[]): CatalogueType[] {
  const byType = new Map<string, CatalogueRecord[]>();
  for (const r of records) {
    const arr = byType.get(r.type);
    if (arr) arr.push(r);
    else byType.set(r.type, [r]);
  }
  return types.filter((t) => needsAi(byType.get(t.id) ?? []));
}

/** The N-th of M parts of a list, deterministic: item i belongs to part (i mod M) + 1. The parts are disjoint, cover the list, differ in size by at most
 * one, and each is a spread over the whole list (so any part alone is a representative sample of the topics, in catalogue order). */
export function chunkOf<T>(items: readonly T[], chunk: Chunk | undefined): T[] {
  if (!chunk) return [...items];
  return items.filter((_, i) => i % chunk.total === chunk.index - 1);
}

// ---------- The work list ----------

export interface AiWorkItem {
  type: CatalogueType;
  seed: number;
}

export interface AiPlan {
  /** Every type that needs the AI step (before the chunk). */
  needs: CatalogueType[];
  /** The part of it this run is responsible for. */
  chunk: CatalogueType[];
  /** To measure now. */
  todo: AiWorkItem[];
  /** Skipped by --resume: already measured under the same configuration. */
  done: AiWorkItem[];
  /** Pairs of `todo` that already carry an AI result of ANOTHER configuration: running them overwrites it. */
  conflicts: AiWorkItem[];
}

export interface PlanOptions {
  /** The types selected by --types (all by default). */
  types: readonly CatalogueType[];
  /** The free records of those types (every seed the file has). */
  records: readonly CatalogueRecord[];
  seeds: readonly number[];
  chunk?: Chunk | undefined;
  config: AiConfigRecord;
  resume: boolean;
}

export function planAiWork(o: PlanOptions): AiPlan {
  const needs = needsAiTypes(o.types, o.records);
  const chunk = chunkOf(needs, o.chunk);
  const aiOf = new Map(o.records.filter((r) => r.ai).map((r) => [`${r.type}#${r.seed}`, r.ai!] as const));
  const todo: AiWorkItem[] = [];
  const done: AiWorkItem[] = [];
  const conflicts: AiWorkItem[] = [];
  for (const type of chunk) {
    for (const seed of o.seeds) {
      const item = { type, seed };
      const old = aiOf.get(`${type.id}#${seed}`);
      if (old && sameAiConfig(old, o.config)) {
        // A measurement that failed as a measurement (every call errored) is not an answer: --resume does it again.
        if (o.resume && old.error === undefined) done.push(item);
        else todo.push(item);
      } else {
        todo.push(item);
        if (old) conflicts.push(item);
      }
    }
  }
  return { needs, chunk, todo, done, conflicts };
}

// ---------- Records ----------

const keyOf = (r: Pick<CatalogueRecord, 'type' | 'seed'>): string => `${r.type}#${r.seed}`;

export interface MergeOptions {
  /** Type ids in catalogue order: the merged records are sorted by it, then by seed (records of unknown types come last). */
  order?: readonly string[];
  /** The fresh records replace the old ones altogether (a full free run), instead of being merged into them by (type, seed). */
  replaceAll?: boolean;
}

/** Merges fresh records into the old ones by (type, seed). A fresh record that carries no AI result keeps the one the old record had: re-measuring the free
 * layers must never throw away AI measurements that cost tokens. */
export function mergeRecords(old: readonly CatalogueRecord[], fresh: readonly CatalogueRecord[], opts: MergeOptions = {}): CatalogueRecord[] {
  const oldByKey = new Map(old.map((r) => [keyOf(r), r] as const));
  const merged = new Map<string, CatalogueRecord>();
  if (!opts.replaceAll) for (const r of old) merged.set(keyOf(r), r);
  for (const f of fresh) {
    const ai = f.ai ?? oldByKey.get(keyOf(f))?.ai;
    const { ai: _drop, ...rest } = f;
    merged.set(keyOf(f), ai !== undefined ? { ...rest, ai } : rest);
  }
  const records = [...merged.values()];
  if (!opts.order) return records;
  const rank = new Map(opts.order.map((id, i) => [id, i] as const));
  const at = (r: CatalogueRecord): number => rank.get(r.type) ?? Number.MAX_SAFE_INTEGER;
  return records.map((r, i) => ({ r, i })).sort((a, b) => at(a.r) - at(b.r) || a.r.seed - b.r.seed || a.i - b.i).map((x) => x.r);
}
