// Registry documents -> the wire shapes of `@formatai/shared`'s api.ts (ids as strings, dates as ISO strings).
import type {
  ConversionDetail,
  ConversionStatus,
  ConversionSummary,
  Format,
  FormatDetail,
  FormatSummary,
  Rules,
  SignatureEntry,
  SourceConversionRef,
  SourceDetail,
  SourceSummary,
} from '@formatai/shared';
import type { ConversionDoc, FormatDoc, SourceDoc } from '../models.js';

/** What one format's conversions add up to (see `aggregateSources`). */
export interface SourceStats {
  sources: number;
  statuses: Partial<Record<ConversionStatus, number>>;
  runCount: number;
  lastRunAt?: Date;
}

export const NO_SOURCES: SourceStats = { sources: 0, statuses: {}, runCount: 0 };

const iso = (d: Date | undefined): string | undefined => (d ? d.toISOString() : undefined);

/**
 * `sourceName` is the SOURCE's name (SPEC 13: the source's own name is the only name - a conversion keeps no copy), read from the
 * source document by the route.
 */
export function conversionSummary(doc: ConversionDoc, sourceName: string): ConversionSummary {
  const lastRunAt = iso(doc.lastRunAt);
  return {
    id: doc._id!.toHexString(),
    formatId: doc.formatId.toHexString(),
    sourceId: doc.sourceId.toHexString(),
    sourceName,
    status: doc.status,
    acceptedDifferences: doc.acceptedDifferences,
    learnPath: doc.learnPath,
    version: doc.version,
    runCount: doc.runCount,
    ...(lastRunAt ? { lastRunAt } : {}),
    ...(doc.lastRun ? { lastRun: { rows: doc.lastRun.rows, flagged: doc.lastRun.flagged } } : {}),
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

/** `sourceFormats`: how many formats the conversion's source feeds (this one included) - the browser warns before an edit of the input side when it is more than one. */
export function conversionDetail(doc: ConversionDoc, sourceName: string, sourceFormats: number): ConversionDetail {
  return {
    ...conversionSummary(doc, sourceName),
    sourceFormats,
    rules: doc.rules as Rules,
    exampleExceptions: doc.exampleExceptions,
    masking: doc.masking,
    ...(doc.model !== undefined ? { model: doc.model } : {}),
    ...(doc.promptVersion !== undefined ? { promptVersion: doc.promptVersion } : {}),
    inputSignature: doc.inputSignature,
  };
}

export function formatSummary(doc: FormatDoc, stats: SourceStats = NO_SOURCES): FormatSummary {
  const output = doc.output as Format['output'];
  const lastRunAt = iso(stats.lastRunAt);
  return {
    id: doc._id!.toHexString(),
    name: doc.name,
    origin: doc.origin,
    version: doc.version,
    fileType: output.file?.type ?? 'xlsx',
    outputColumns: output.columns.length,
    outputHeaders: output.columns.map((c) => c.header),
    sources: stats.sources,
    statuses: stats.statuses,
    runCount: stats.runCount,
    ...(lastRunAt ? { lastRunAt } : {}),
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

export function formatDetail(doc: FormatDoc, stats: SourceStats): FormatDetail {
  return {
    ...formatSummary(doc, stats),
    output: doc.output,
    layout: doc.layout,
    outputValidations: doc.outputValidations,
  };
}

/** The format as the engine's lock check takes it. */
export function formatOfDoc(doc: Pick<FormatDoc, 'output' | 'layout' | 'outputValidations'>): Format {
  return { output: doc.output, layout: doc.layout, outputValidations: doc.outputValidations } as Format;
}

/** Folds one format's conversions (only the fields these stats need) into its stats. */
export function aggregateSources(docs: readonly Pick<ConversionDoc, 'status' | 'runCount' | 'lastRunAt'>[]): SourceStats {
  const stats: SourceStats = { sources: 0, statuses: {}, runCount: 0 };
  for (const d of docs) {
    stats.sources += 1;
    stats.statuses[d.status] = (stats.statuses[d.status] ?? 0) + 1;
    stats.runCount += d.runCount;
    if (d.lastRunAt && (!stats.lastRunAt || d.lastRunAt > stats.lastRunAt)) stats.lastRunAt = d.lastRunAt;
  }
  return stats;
}

// ---------------------------------------------------------------- sources (SPEC 8.15)

/** The conversions of one source with the names of the formats they feed (`formatNames`: format id -> name). */
export function conversionRefs(
  conversions: readonly Pick<ConversionDoc, '_id' | 'formatId' | 'status'>[],
  formatNames: ReadonlyMap<string, string>,
): SourceConversionRef[] {
  return conversions.map((c) => ({
    conversionId: c._id!.toHexString(),
    formatId: c.formatId.toHexString(),
    formatName: formatNames.get(c.formatId.toHexString()) ?? '',
    status: c.status,
  }));
}

export function sourceSummary(
  doc: SourceDoc,
  conversions: readonly Pick<ConversionDoc, '_id' | 'formatId' | 'status' | 'runCount' | 'lastRunAt'>[],
  formatNames: ReadonlyMap<string, string>,
): SourceSummary {
  const stats = aggregateSources(conversions);
  const lastRunAt = iso(stats.lastRunAt);
  return {
    id: doc._id!.toHexString(),
    name: doc.name,
    columns: doc.inputSignature.columns.length,
    conversions: conversionRefs(conversions, formatNames),
    statuses: stats.statuses,
    version: doc.version,
    runCount: stats.runCount,
    ...(lastRunAt ? { lastRunAt } : {}),
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

export function sourceDetail(
  doc: SourceDoc,
  conversions: readonly Pick<ConversionDoc, '_id' | 'formatId' | 'status' | 'runCount' | 'lastRunAt'>[],
  formatNames: ReadonlyMap<string, string>,
): SourceDetail {
  return {
    ...sourceSummary(doc, conversions, formatNames),
    inputSignature: doc.inputSignature,
    inputReading: doc.inputReading,
    inputValidations: doc.inputValidations,
  };
}

/** One entry of GET /api/signatures: a source's signature (what matching reads) with the formats it feeds. */
export function signatureEntry(
  doc: SourceDoc,
  conversions: readonly Pick<ConversionDoc, '_id' | 'formatId' | 'status'>[],
  formatNames: ReadonlyMap<string, string>,
): SignatureEntry {
  return {
    sourceId: doc._id!.toHexString(),
    name: doc.name,
    columns: doc.inputSignature.columns.map((c) => ({ header: c.header, aliases: c.aliases, type: c.type, required: c.required })),
    ...(doc.ignoredHeaders && doc.ignoredHeaders.length > 0 ? { ignoredHeaders: [...doc.ignoredHeaders] } : {}),
    conversions: conversionRefs(conversions, formatNames),
  };
}
