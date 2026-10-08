// Shared pieces of the Convert and Batch tests: a small saved source (rules + signature), a fake ConvertApi that records
// every call, a fake or real engine, and one `renderConvert` that puts a screen inside the providers it needs.
// The API's GET /api/signatures gives ONE ENTRY PER SOURCE with the conversions (formats) it feeds (SPEC 8.15): `entry` builds a
// source with one conversion from the per-conversion parameters, `sourceEntry` a source with several.
import type { ConversionMatch } from '@formatai/engine';
import { tiers, type ConversionDetail, type ConversionStatus, type MeUser, type Rules, type SignatureColumn, type SignatureEntry, type SourceConversionRef, type UpdateConversionRequest, type UpdateConversionResponse } from '@formatai/shared';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { vi, type Mock } from 'vitest';
import { ConvertApiProvider, type ConvertApi } from '../../src/api/convert';
import { MeProvider } from '../../src/app/Me';
import { I18nProvider, type Lang } from '../../src/i18n';
import { fakeApi } from './renderApp';
import { ServicesProvider } from '../../src/services';
import type { ColumnGapsArgs } from '../../src/worker/convertApi';
import { convertMethods } from '../../src/worker/convertMethods';
import type { EngineClient } from '../../src/worker/engineClient';

/** Supplier A's price list -> a CSV load file. "Item Code" and "Qty" are required; "Price" is optional. */
export const RULES: Rules = {
  schemaVersion: 1,
  input: {
    sheet: { pick: 'first' },
    headerRow: 'auto',
    columns: [
      { id: 'c_code', header: 'Item Code', type: 'idLike', required: true },
      { id: 'c_qty', header: 'Qty', type: 'integer', required: true },
      { id: 'c_price', header: 'Price', type: 'decimal' },
    ],
  },
  transform: { computed: [], valueMaps: [], sort: [] },
  output: {
    sheetName: 'Load',
    direction: 'ltr',
    language: 'en',
    titleRows: [],
    columns: [
      { header: 'Code', from: 'c_code' },
      { header: 'Quantity', from: 'c_qty' },
      { header: 'Unit price', from: 'c_price' },
    ],
    file: { type: 'csv' },
  },
  validations: [{ column: 'c_code', rule: 'lengthEquals', length: 5, severity: 'flag' }],
  unsupported: [],
  assumptions: [],
  name: 'Supplier A',
  meta: { source: 'examplePair', status: 'verified' },
};

/** The worker's own `columnGaps` (pure, no file): what the fake engines answer with, so these tests meet the engine's real header mapping. */
export const realColumnGaps = (args: ColumnGapsArgs) => convertMethods.columnGaps(args);

export const csvFile =(name: string, body: string): File => new File([body], name, { type: 'text/csv' });

/** A price list as Supplier A sends it. Row 3 has a code that is too short and a quantity that isn't a number. */
export const SUPPLIER_A_CSV = 'Item Code,Qty,Price,Extra\n00001,5,10.5,x\n123,abc,3,y\n00003,7,4,z\n';
/** The same list, clean. */
export const SUPPLIER_A_CLEAN_CSV = 'Item Code,Qty,Price,Extra\n00001,5,10.5,x\n00002,6,3,y\n00003,7,4,z\n';

/** Supplier A's signature: "Item Code" and "Qty" are required, "Price" is optional. */
export const SUPPLIER_A_COLUMNS: SignatureColumn[] = [
  { header: 'Item Code', aliases: [], type: 'idLike', required: true },
  { header: 'Qty', aliases: [], type: 'integer', required: true },
  { header: 'Price', aliases: [], type: 'decimal', required: false },
];

/** A source (one entry of GET /api/signatures) that feeds one or several formats. */
export function sourceEntry(over: { sourceId: string; name?: string; columns?: SignatureColumn[]; conversions: (Partial<SourceConversionRef> & { conversionId: string })[] }): SignatureEntry {
  return {
    sourceId: over.sourceId,
    name: over.name ?? 'Supplier A',
    columns: over.columns ?? SUPPLIER_A_COLUMNS,
    conversions: over.conversions.map((c) => ({ formatId: 'F1', formatName: 'Load file', status: 'verified' as ConversionStatus, ...c })),
  };
}

/**
 * A source with ONE conversion, from the per-conversion parameters the tests were first written with: the source's id is the
 * conversion id (unless `sourceId` says otherwise) and its name is `sourceName`.
 */
export function entry(over: { conversionId: string; sourceId?: string; sourceName?: string; formatId?: string; formatName?: string; status?: ConversionStatus; columns?: SignatureColumn[] }): SignatureEntry {
  return sourceEntry({
    sourceId: over.sourceId ?? over.conversionId,
    name: over.sourceName ?? 'Supplier A',
    ...(over.columns ? { columns: over.columns } : {}),
    conversions: [
      {
        conversionId: over.conversionId,
        ...(over.formatId ? { formatId: over.formatId } : {}),
        ...(over.formatName ? { formatName: over.formatName } : {}),
        ...(over.status ? { status: over.status } : {}),
      },
    ],
  });
}

export function detail(over: Partial<ConversionDetail> & { id: string }, rules: Rules = RULES): ConversionDetail {
  return {
    formatId: 'F1',
    sourceId: 'S1',
    sourceName: 'Supplier A',
    status: 'verified',
    acceptedDifferences: 0,
    learnPath: 'local',
    version: 1,
    runCount: 0,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    rules,
    exampleExceptions: [],
    masking: true,
    inputSignature: { columns: [] },
    sourceFormats: 1,
    ...over,
  };
}

export function match(over: Partial<ConversionMatch> & { id: string }): ConversionMatch {
  // `unknownExtra` is `extra` unless the test says the source already knew some of them.
  return { name: 'Supplier A', score: 1, missingRequired: [], extra: [], unknownExtra: over.extra ?? [], renamedCandidates: [], ...over };
}

export const REGISTERED: MeUser = { id: 'u1', name: 'Dana', avatarUrl: null, tier: 'registered', providers: ['google'], isAdmin: false, uiLanguage: null };
export const PAID: MeUser = { ...REGISTERED, tier: 'paid' };

/** Every call is recorded (and can be given another answer). `user` is who is signed in: the app's `useMe()` reads it (see `renderConvert`). */
export type FakeConvertApi = { [K in keyof ConvertApi]: Mock<ConvertApi[K]> } & { user: MeUser | null };

export function fakeConvertApi(opts: { user?: MeUser | null; entries?: SignatureEntry[]; rules?: Rules; rulesById?: Record<string, Rules> } = {}): FakeConvertApi {
  const user = opts.user === undefined ? REGISTERED : opts.user;
  const entries = opts.entries ?? [entry({ conversionId: 'c1' })];
  return {
    user,
    signatures: vi.fn(async () => entries),
    conversion: vi.fn(async (id: string) => {
      const source = entries.find((e) => e.conversions.some((c) => c.conversionId === id));
      const conv = source?.conversions.find((c) => c.conversionId === id);
      return detail({ id, sourceName: source?.name ?? 'Supplier A', formatId: conv?.formatId ?? 'F1', sourceFormats: source?.conversions.length ?? 1, ...(source ? { sourceId: source.sourceId } : {}) }, opts.rulesById?.[id] ?? opts.rules ?? RULES);
    }),
    recordRun: vi.fn(async () => undefined),
    widenRanges: vi.fn(async (_id: string, columns: Readonly<Record<string, { lo: number; hi: number }>>) => Object.keys(columns)),
    addAlias: vi.fn(async () => undefined),
    ignoreHeaders: vi.fn(async () => undefined),
    // An editor-style save: the next version, and - when the source feeds more formats - the change reached the others (as the server says).
    saveRules: vi.fn(async (id: string, body: UpdateConversionRequest): Promise<UpdateConversionResponse> => {
      const source = entries.find((e) => e.conversions.some((c) => c.conversionId === id));
      const others = (source?.conversions.length ?? 1) - 1;
      return {
        conversion: detail({ id, version: (body.baseVersion ?? 1) + 1 }, (body.rules as Rules | undefined) ?? RULES),
        formatChanged: false,
        affectedSources: 0,
        needsReview: [],
        ...(source ? { sourceChanged: true, affectedConversions: others } : {}),
      };
    }),
  };
}

/** Prints where the router is, so a test can see a navigation. */
export function LocationProbe() {
  const loc = useLocation();
  return <p data-testid="location">{loc.pathname + loc.search}</p>;
}

export interface RenderConvertOptions {
  api: ConvertApi;
  engine: EngineClient;
  lang?: Lang;
  route?: string;
}

/** One screen inside i18n, the services, `MeProvider` (fed by `api.user`), the convert API and a memory router (with a location probe). */
export function renderConvert(ui: ReactElement, { api, engine, lang = 'en', route = '/convert' }: RenderConvertOptions) {
  const user = (api as Partial<FakeConvertApi>).user ?? null;
  return render(
    <I18nProvider initial={lang}>
      <ServicesProvider engine={engine} api={fakeApi({ user })}>
        <ConvertApiProvider api={api}>
          <MemoryRouter initialEntries={[route]}>
            <MeProvider>
              {ui}
              <LocationProbe />
            </MeProvider>
          </MemoryRouter>
        </ConvertApiProvider>
      </ServicesProvider>
    </I18nProvider>,
  );
}

export const FILES_PER_RUN = { registered: tiers.registered.filesPerRun, paid: tiers.paid.filesPerRun };
