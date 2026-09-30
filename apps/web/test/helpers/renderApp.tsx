import { tiers, type LearnPayload, type LearnResult } from '@formatai/shared';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import { App } from '../../src/app/App';
import type { Api } from '../../src/api';
import { I18nProvider, type Lang } from '../../src/i18n';
import { ServicesProvider } from '../../src/services';
import type { LearnHost, LearnOutput } from '../../src/worker/engineApi';
import type { EngineClient } from '../../src/worker/engineClient';

export const RULES = { schemaVersion: 1, output: { columns: [] } } as unknown as LearnResult;

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
    verification: { verified: true, matched: 3, total: 3, mismatches: [], layoutProblems: [], repairProblems: [] },
    assumptions: [],
    unsupported: [],
    calls: [],
    stages: {},
    ...over,
  } as unknown as LearnOutput;
}

type LearnImpl = (host: LearnHost) => Promise<LearnOutput>;

export interface FakeEngine {
  engine: EngineClient;
  learn: ReturnType<typeof vi.fn>;
  inspect: ReturnType<typeof vi.fn>;
}

export function fakeEngine(impl: LearnImpl = async () => learnResult(), inspect?: () => unknown): FakeEngine {
  const learn = vi.fn(async (_args: unknown, host: LearnHost) => impl(host));
  const inspectFn = vi.fn(async () => (inspect ? inspect() : { readable: true, rows: 1204, columns: 8, direction: 'ltr' }));
  const engine = { learn, inspect: inspectFn, convert: vi.fn(), verify: vi.fn(), terminate: vi.fn() } as unknown as EngineClient;
  return { engine, learn, inspect: inspectFn };
}

export function fakeApi(over: Partial<Api> = {}): Api & { learn: ReturnType<typeof vi.fn>; session: ReturnType<typeof vi.fn> } {
  return {
    session: vi.fn(async () => ({ anonId: true, tier: 'free', limits: tiers.anonymous })),
    learn: vi.fn(async () => ({ rules: RULES, verified: true, problems: [], learnId: 'L1', cached: false })),
    repair: vi.fn(),
    ...over,
  } as unknown as Api & { learn: ReturnType<typeof vi.fn>; session: ReturnType<typeof vi.fn> };
}

export function csv(name: string, body = 'a,b\n1,2\n3,4\n'): File {
  return new File([body], name, { type: 'text/csv' });
}

export interface RenderAppOptions {
  lang?: Lang;
  route?: string;
  engine?: EngineClient;
  api?: Api;
}

/** The whole app, with fake engine and API (nothing real is spawned or sent). */
export function renderApp({ lang = 'en', route = '/', engine = fakeEngine().engine, api = fakeApi() }: RenderAppOptions = {}) {
  return renderWithProviders(<App />, { lang, route, engine, api });
}

export function renderWithProviders(ui: ReactElement, { lang = 'en', route = '/', engine = fakeEngine().engine, api = fakeApi() }: RenderAppOptions = {}) {
  return render(
    <I18nProvider initial={lang}>
      <ServicesProvider engine={engine} api={api}>
        <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
      </ServicesProvider>
    </I18nProvider>,
  );
}
