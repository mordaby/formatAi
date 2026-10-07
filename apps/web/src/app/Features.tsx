// The feature switches the API runs with (owner decision 2026-10-07; shared `config/features.ts`): read from `GET /api/session` at startup, so
// turning one on or off on the server needs no new build. Until the answer is in - and when it cannot be read, or an older API sends none -
// every switch is at the config's default (OFF for "Formats with several sources": nothing is offered that the server may refuse).
//
// "Formats with several sources" (`formatSources`) gates the source-related UI, and only it: Save's "Is this one of your formats?" (#75) with
// its source-limit lines, and the "Add a source" entry points and screen. The "You already have this format" check at Learn does not read it.
import { features as defaults, type Features, type SessionResponse } from '@formatai/shared';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Api } from '../api';
import { useServices } from '../services';

/** One `GET /api/session` per API client, however many readers (the Turnstile key, the feature switches): asked once, shared. */
const sessions = new WeakMap<Api, Promise<SessionResponse>>();

/** The API's `/api/session` answer, read once (a failed read is forgotten, so the next reader asks again). */
export function readSession(api: Api): Promise<SessionResponse> {
  let p = sessions.get(api);
  if (!p) {
    p = api.session();
    sessions.set(api, p);
    p.catch(() => sessions.delete(api));
  }
  return p;
}

export interface FeatureState extends Features {
  /** The server has answered (until then every switch is at its default). */
  known: boolean;
}

const DEFAULTS: FeatureState = { ...defaults, known: false };

const FeaturesContext = createContext<FeatureState | null>(null);

/** The switches as the server says; outside a provider (a screen rendered alone in a test), the config's defaults. */
export function useFeatures(): FeatureState {
  return useContext(FeaturesContext) ?? DEFAULTS;
}

export function FeaturesProvider({ children }: { children: ReactNode }) {
  const { api } = useServices();
  const [state, setState] = useState<FeatureState>(DEFAULTS);
  useEffect(() => {
    let alive = true;
    readSession(api)
      .then((s) => {
        if (alive) setState({ ...defaults, ...(s.features ?? {}), known: true });
      })
      // Unreachable: the defaults stand (and the screens that need the server say so where it matters).
      .catch(() => {
        if (alive) setState({ ...defaults, known: true });
      });
    return () => {
      alive = false;
    };
  }, [api]);
  const value = useMemo(() => state, [state]);
  return <FeaturesContext.Provider value={value}>{children}</FeaturesContext.Provider>;
}
