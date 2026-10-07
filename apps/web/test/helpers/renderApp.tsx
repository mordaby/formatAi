import { findFormatMatches } from '@formatai/engine';
import { features as defaultFeatures, tiers, type Features, type LearnPayload, type LearnResult, type MeUser } from '@formatai/shared';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { createMemoryRouter, MemoryRouter, RouterProvider } from 'react-router-dom';
import { vi } from 'vitest';
import { App } from '../../src/app/App';
import type { Api } from '../../src/api';
import type { AuthApi } from '../../src/api/auth';
import type { ContactApi } from '../../src/api/contact';
import type { RegistryApi } from '../../src/api/registry';
import { I18nProvider, type Lang } from '../../src/i18n';
import { ServicesProvider } from '../../src/services';
import type { LearnArgs, LearnHost, LearnOutput } from '../../src/worker/engineApi';
import type { LiveCheckResult } from '../../src/worker/editorApi';
import type { EngineClient } from '../../src/worker/engineClient';
import { rules as fixtureRules } from '../../src/rulesText/fixtures';

/** A small valid rules file (one plain column): the Result screen reads real rules. */
export const RULES: LearnResult = fixtureRules();

/** A live check that matched every row. */
export function liveResult(over: Partial<LiveCheckResult> = {}): LiveCheckResult {
  return {
    verified: true,
    matched: 3,
    total: 3,
    differences: 0,
    perColumn: [{ header: 'Name', inExample: true, matched: 3, total: 3 }],
    mismatches: [],
    mismatchCount: 0,
    preview: [],
    layoutProblems: [],
    layoutIssues: [],
    partial: false,
    checkedInputRows: 3,
    totalInputRows: 3,
    ms: 1,
    ...over,
  };
}

export const PAYLOAD_SKIP = {
  masking: true,
  output: { columns: [{ i: 0, header: 'Order ID' }, { i: 1, header: 'Assigned Warehouse' }] },
  samples: [],
  skipColumns: [1],
} as unknown as LearnPayload;

export function learnResult(over: Record<string, unknown> = {}): LearnOutput {
  return {
    path: 'local',
    preflight: { status: 'ok', issues: [], skipColumns: [] },
    rules: RULES,
    verification: { verified: true, matched: 3, total: 3, mismatches: [], layoutProblems: [], layoutIssues: [], repairProblems: [] },
    assumptions: [],
    unsupported: [],
    calls: [],
    stages: {},
    exampleId: 'ex1',
    ...over,
  } as unknown as LearnOutput;
}

/** `args`: what the screen asked the worker for (the target, `ai`, ...), for a fake that answers as the engine would. */
type LearnImpl = (host: LearnHost, args: LearnArgs) => Promise<LearnOutput>;

export interface FakeEngine {
  engine: EngineClient;
  learn: ReturnType<typeof vi.fn>;
  inspect: ReturnType<typeof vi.fn>;
}

export function fakeEngine(impl: LearnImpl = async () => learnResult(), inspect?: () => unknown, extra: Record<string, unknown> = {}): FakeEngine {
  const learn = vi.fn(async (args: LearnArgs, host: LearnHost) => impl(host, args));
  const inspectFn = vi.fn(async () => (inspect ? inspect() : { readable: true, rows: 1204, columns: 8, direction: 'ltr' }));
  const engine = {
    learn,
    inspect: inspectFn,
    convert: vi.fn(),
    // The rules editor's checks: every row matches, nothing is wrong.
    liveCheck: vi.fn(async () => liveResult()),
    fullCheck: vi.fn(async () => liveResult()),
    staticChecks: vi.fn(async () => []),
    // Reading an example pair again (a saved source's optional check), and a file's headers (Add a source).
    loadExample: vi.fn(async () => ({ ok: true, exampleId: 'ex-loaded', inputRows: 3, outputRows: 3 })),
    readHeaders: vi.fn(async () => ({ ok: true, headers: [], sheetName: 'Sheet1', direction: 'ltr', rows: 3 })),
    // "Is this one of your formats?" at Save: the engine's own comparison (rules and headers only, nothing to fake).
    formatMatches: vi.fn(async (args: Parameters<typeof findFormatMatches>[0]) => findFormatMatches(args)),
    terminate: vi.fn(),
    ...extra,
  } as unknown as EngineClient;
  return { engine, learn, inspect: inspectFn };
}

/** A registered user, for the signed-in screens. */
export const USER: MeUser = { id: 'u1', name: 'Dana Levi', avatarUrl: null, email: 'dana@example.com', tier: 'registered', providers: ['google'], isAdmin: false, uiLanguage: null };

export type FakeApi = Api & {
  learn: ReturnType<typeof vi.fn>;
  session: ReturnType<typeof vi.fn>;
  auth: { [K in keyof AuthApi]: ReturnType<typeof vi.fn> };
  registry: { [K in keyof RegistryApi]: ReturnType<typeof vi.fn> };
  contact: { [K in keyof ContactApi]: ReturnType<typeof vi.fn> };
};

/**
 * A fake API: an anonymous visitor on a server with both providers, and an empty registry. Override any call
 * (`auth` and `registry` are merged one level deep); `user` makes GET /api/me answer with that user; `features` are the switches
 * GET /api/session reports (default: the config's - "Formats with several sources" off).
 */
export function fakeApi(
  over: Partial<Omit<Api, 'auth' | 'registry' | 'contact'>> & { auth?: Partial<AuthApi>; registry?: Partial<RegistryApi>; contact?: Partial<ContactApi>; user?: MeUser | null; features?: Partial<Features> } = {},
): FakeApi {
  const { auth, registry, contact, user, features, ...rest } = over;
  return {
    session: vi.fn(async () => ({ anonId: true, tier: 'free', limits: tiers.anonymous, features: { ...defaultFeatures, ...features } })),
    learn: vi.fn(async () => ({ rules: RULES, verified: true, problems: [], learnId: 'L1', cached: false })),
    repair: vi.fn(),
    step: vi.fn(),
    baseUrl: '',
    auth: {
      providers: vi.fn(async () => ['google', 'microsoft']),
      me: vi.fn(async () => user ?? null),
      logout: vi.fn(async () => undefined),
      setLanguage: vi.fn(async () => user ?? null),
      linkStart: vi.fn(async () => 'https://accounts.example/link'),
      quota: vi.fn(async () => ({ remaining: 3, period: 'month' })),
      ...auth,
    },
    registry: {
      listFormats: vi.fn(async () => []),
      getFormat: vi.fn(),
      createFormat: vi.fn(),
      renameFormat: vi.fn(),
      deleteFormat: vi.fn(async () => undefined),
      attachSource: vi.fn(),
      // The company's sources (SPEC 8.15): none unless a test says so.
      listSources: vi.fn(async () => []),
      // Every source's signature ("is this example one of your sources?" at Save): none unless a test says so.
      signatures: vi.fn(async () => []),
      getSource: vi.fn(),
      updateSource: vi.fn(),
      deleteSource: vi.fn(async () => undefined),
      getConversion: vi.fn(),
      updateConversion: vi.fn(),
      deleteConversion: vi.fn(async () => undefined),
      versions: vi.fn(async () => []),
      restore: vi.fn(),
      learnOutcome: vi.fn(async () => ({ counted: true, quota: { remaining: 2, period: 'month' }, failedAttempts: 0, exhausted: false })),
      ...registry,
    },
    // The public forms (lead, waitlist, feedback): every send works unless a test says otherwise.
    contact: {
      lead: vi.fn(async () => undefined),
      waitlist: vi.fn(async () => undefined),
      feedback: vi.fn(async () => undefined),
      ...contact,
    },
    ...rest,
  } as unknown as FakeApi;
}

export function csv(name: string, body = 'a,b\n1,2\n3,4\n'): File {
  return new File([body], name, { type: 'text/csv' });
}

export interface RenderAppOptions {
  lang?: Lang;
  route?: string;
  engine?: EngineClient;
  api?: Api;
  /** Use a data router like the real app does (only that kind of router can hold back a change of screen, e.g. "Unsaved changes"). */
  dataRouter?: boolean;
}

/** The whole app, with fake engine and API (nothing real is spawned or sent). */
export function renderApp({ lang = 'en', route = '/', engine = fakeEngine().engine, api = fakeApi(), dataRouter = false }: RenderAppOptions = {}) {
  return renderWithProviders(<App />, { lang, route, engine, api, dataRouter });
}

/** What is rendered, and (with `dataRouter`) the router, to read where the app has gone. */
export function renderWithProviders(ui: ReactElement, { lang = 'en', route = '/', engine = fakeEngine().engine, api = fakeApi(), dataRouter = false }: RenderAppOptions = {}) {
  const router = dataRouter ? createMemoryRouter([{ path: '*', element: ui }], { initialEntries: [route] }) : undefined;
  const view = render(
    <I18nProvider initial={lang}>
      <ServicesProvider engine={engine} api={api}>
        {router ? <RouterProvider router={router} /> : <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>}
      </ServicesProvider>
    </I18nProvider>,
  );
  return Object.assign(view, { router });
}
