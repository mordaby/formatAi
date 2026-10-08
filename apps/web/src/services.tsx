import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { getApi, type Api } from './api';
import type { Track } from './api/events';
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

const noTrack: Track = () => undefined;

/**
 * `track(type, props)` for the usage events (SPEC 14.1), from the services in reach. Safe anywhere: with no provider (a component rendered on its
 * own), with an API that has no emitter (a fake), or with an emitter that fails, it does nothing - an event is never worth an error on screen.
 * The function is the same on every render, so it can be a dependency.
 */
export function useTrack(): Track {
  const ctx = useContext(ServicesContext);
  const events = ctx?.api.events;
  return useMemo<Track>(() => {
    if (!events) return noTrack;
    return (type, props) => {
      try {
        events.track(type, props);
      } catch {
        // Never into the UI.
      }
    };
  }, [events]);
}
