// Feature switches (owner decision 2026-10-07): a part of the product that is built but not shown until the owner turns it on. Each switch
// has its default here; the API may override it from its environment and tells the web app the value it runs with (`GET /api/session`
// `features`), so turning one on or off is a configuration change, not a new build.
//
// `formatSources` - "Formats with several sources" (SPEC 5 A2, 8.12, 8.15, 16; SPEC 20). OFF for the MVP. When off, the product stays
// simple: a learned format is saved as its own format (Save asks nothing about the user's saved formats), there is no "Add a source" anywhere
// and the API refuses to attach a source to a format (403 `featureOff`), and nothing says "source". Sources still exist behind the scenes,
// created and reused silently when a format is saved (SPEC 8.15). The "You already have this format" check at Learn does not depend on it.
// API override: `FEATURE_FORMAT_SOURCES=on|off` (unset: this default; any other value stops a production start).

export interface Features {
  /** "Formats with several sources": Save's "Is this one of your formats?", "Add a source", the attach route. */
  formatSources: boolean;
}

export const features: Readonly<Features> = {
  formatSources: false,
};

export const FEATURE_SWITCH_VALUES = ['on', 'off'] as const;

/**
 * A switch's environment value as the API reads it: unset or empty is `fallback` (the config's default); `on` / `off` (any case, spaces
 * around ignored) say it outright; anything else is `null`, which a production start refuses (a typo must never silently mean "off").
 */
export function featureSwitchOf(raw: string | undefined, fallback: boolean): boolean | null {
  if (raw === undefined || raw.trim() === '') return fallback;
  const v = raw.trim().toLowerCase();
  return v === 'on' ? true : v === 'off' ? false : null;
}
