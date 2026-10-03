// Builders for the registry screens' tests: a saved format, its sources, and a stored conversion with real rules.
import type { ConversionDetail, ConversionSummary, CreateFormatResponse, FormatDetail, FormatSummary, GetFormatResponse, Rules, SourceSummary } from '@formatai/shared';
import { ordersRules } from '../../src/editor/testkit';

export function formatSummary(over: Partial<FormatSummary> & { id: string; name: string }): FormatSummary {
  return {
    origin: 'learned',
    version: 1,
    fileType: 'xlsx',
    outputColumns: 6,
    outputHeaders: ordersRules().output.columns.map((c) => c.header),
    sources: 1,
    statuses: { verified: 1 },
    runCount: 0,
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T10:00:00.000Z',
    ...over,
  };
}

export function conversionSummary(over: Partial<ConversionSummary> & { id: string }): ConversionSummary {
  return {
    formatId: 'F1',
    sourceId: 'S1',
    sourceName: 'Supplier A',
    status: 'verified',
    acceptedDifferences: 0,
    learnPath: 'local',
    version: 1,
    runCount: 0,
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T10:00:00.000Z',
    ...over,
  };
}

/** The format as GET /api/formats/:id gives it: the output side of the orders rules. */
export function formatDetail(over: Partial<FormatDetail> & { id: string; name: string }, rules: Rules = ordersRules()): FormatDetail {
  return {
    ...formatSummary({ ...over }),
    output: { ...rules.output, columns: rules.output.columns.map(({ from: _from, ...c }) => c) },
    layout: { sort: [] },
    outputValidations: [],
    ...over,
  } as FormatDetail;
}

export function getFormatResponse(over: { id?: string; name?: string; sources?: ConversionSummary[]; detail?: Partial<FormatDetail> } = {}): GetFormatResponse {
  const id = over.id ?? 'F1';
  const sources = over.sources ?? [conversionSummary({ id: 'C1', formatId: id })];
  return { format: formatDetail({ id, name: over.name ?? 'Orders report', sources: sources.length, ...over.detail }), conversions: sources };
}

export function conversionDetail(over: Partial<ConversionDetail> & { id: string }, rules: Rules = ordersRules()): ConversionDetail {
  return {
    ...conversionSummary({ id: over.id }),
    rules,
    exampleExceptions: [],
    masking: true,
    inputSignature: { columns: [] },
    sourceFormats: 1,
    ...over,
  };
}

/** POST /api/formats 201 body (SPEC 8.15): the format, its conversion, and the source the conversion belongs to (`formats`: how many it feeds). */
export function createFormatResponse(over: { format?: FormatSummary; conversion?: ConversionSummary; source?: { id: string; name: string; formats?: number }; sourceReused?: { id: string; name: string } } = {}): CreateFormatResponse {
  const conversion = over.conversion ?? conversionSummary({ id: 'C1', formatId: 'F1' });
  return {
    format: over.format ?? formatSummary({ id: 'F1', name: 'Orders report' }),
    conversion,
    source: { id: over.source?.id ?? conversion.sourceId, name: over.source?.name ?? conversion.sourceName, formats: over.source?.formats ?? 1 },
    ...(over.sourceReused ? { sourceReused: over.sourceReused } : {}),
  };
}

/** GET /api/sources: one source of the company, with the formats it feeds (none by default). */
export function sourceSummary(over: Partial<SourceSummary> & { id: string; name: string }): SourceSummary {
  const conversions = over.conversions ?? [];
  const statuses: SourceSummary['statuses'] = {};
  for (const c of conversions) statuses[c.status] = (statuses[c.status] ?? 0) + 1;
  return {
    columns: 4,
    conversions,
    statuses,
    version: 1,
    runCount: 0,
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T10:00:00.000Z',
    ...over,
  };
}
