import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { getApi, type Api } from './api';
import { getEngine, type EngineClient } from './worker/engineClient';

export interface Services {
  engine: EngineClient;
  api: Api;
}

const ServicesContext = createContext<Services | null>(null);

export interface ServicesProviderProps {
  /** Override either service (tests pass fakes). Defaults: the real worker-backed engine and the real API client. */
  engine?: EngineClient;
  api?: Api;
  children: ReactNode;
}

/** Provides the engine (worker) client and the API client. Neither spawns anything until first used. */
export function ServicesProvider({ engine, api, children }: ServicesProviderProps) {
  const value = useMemo<Services>(() => ({ engine: engine ?? getEngine(), api: api ?? getApi() }), [engine, api]);
  return <ServicesContext.Provider value={value}>{children}</ServicesContext.Provider>;
}

export function useServices(): Services {
  const ctx = useContext(ServicesContext);
  if (!ctx) throw new Error('useServices must be used inside <ServicesProvider>');
  return ctx;
}
