// Feature switches (owner decision 2026-10-07): a part of the product that is built but not shown until the owner turns it on. Each switch
// has its default here; the API may override it from its environment and tells the web app the value it runs with (`GET /api/session`
// `features`), so turning one on or off is a configuration change, not a new build.
//
// `formatSources` - "Formats with several sources" (SPEC 5 A2, 8.12, 8.15, 16). OFF for the MVP. It hides only the EXPLICIT source UI: the
// "Add a source" buttons and screen, and the source counts and names on My formats' cards. A format is the output; each kind of input file
// has its own rules, kept as a "source" behind the scenes - and what the learn does with that is on whatever the switch says: "You already
// have this format", "Is this file another input for it?" (a learn against that format, saved as another input of it: the API's attach
// route, which the switch therefore does not close - its limit and locks still hold), and Save's "Update your format X?".
// API override: `FEATURE_FORMAT_SOURCES=on|off` (unset: this default; any other value stops a production start).

export interface Features {
  /** "Formats with several sources": the explicit source UI ("Add a source", source counts and names on the cards). */
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
