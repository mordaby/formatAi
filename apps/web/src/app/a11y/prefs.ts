// The accessibility panel's settings (owner request; IS 5568 / WCAG 2.1 AA): what can be changed, how it is kept, and how it reaches the page.
//
// Every setting is a class on <html> (`a11y-*`), so it covers the whole page - dialogs and menus that render in a portal included - in both
// themes and both languages; `styles/a11y.css` says what each class does (text size and spacing through CSS variables, the rest through the
// colour tokens and a few rules). The choices are kept per browser in localStorage, and every read and write is wrapped in try/catch: storage
// can be missing or throw (a private window, blocked site data, a test), and the page must work without it.
//
// DECISION: three text sizes (normal, large 125%, larger 150%) rather than a free slider - three steps are easy to name and to test, and the
// browser's own zoom still goes to 200% (WCAG 1.4.4).

export type TextSize = 0 | 1 | 2;

export interface A11yPrefs {
  textSize: TextSize;
  /** High contrast: white / black paper, black / white ink, dark / light brand colour, strong borders. */
  contrast: boolean;
  /** Every link underlined. */
  links: boolean;
  /** A plain, widely installed sans-serif instead of IBM Plex Sans Hebrew. */
  font: boolean;
  /** No animation or transition at all (on top of the system's reduced-motion setting, which is always honoured). */
  motion: boolean;
  /** A thick, double-coloured focus ring. */
  focus: boolean;
  /** More space between lines, letters and words (WCAG 1.4.12). */
  spacing: boolean;
}

export const DEFAULT_PREFS: A11yPrefs = { textSize: 0, contrast: false, links: false, font: false, motion: false, focus: false, spacing: false };

/** The localStorage key. */
export const A11Y_STORAGE_KEY = 'formatai.a11y';

/** The classes put on <html>, one per setting that is on. */
export const A11Y_CLASS = {
  text1: 'a11y-text-1',
  text2: 'a11y-text-2',
  contrast: 'a11y-contrast',
  links: 'a11y-links',
  font: 'a11y-font',
  motion: 'a11y-motion',
  focus: 'a11y-focus',
  spacing: 'a11y-spacing',
} as const;

const ALL_CLASSES: readonly string[] = Object.values(A11Y_CLASS);

/** The classes `prefs` asks for. */
export function classesOf(prefs: A11yPrefs): string[] {
  const out: string[] = [];
  if (prefs.textSize === 1) out.push(A11Y_CLASS.text1);
  if (prefs.textSize === 2) out.push(A11Y_CLASS.text2);
  if (prefs.contrast) out.push(A11Y_CLASS.contrast);
  if (prefs.links) out.push(A11Y_CLASS.links);
  if (prefs.font) out.push(A11Y_CLASS.font);
  if (prefs.motion) out.push(A11Y_CLASS.motion);
  if (prefs.focus) out.push(A11Y_CLASS.focus);
  if (prefs.spacing) out.push(A11Y_CLASS.spacing);
  return out;
}

/** Puts exactly the classes `prefs` asks for on `root` (other classes are left alone). */
export function applyPrefs(prefs: A11yPrefs, root: HTMLElement = document.documentElement): void {
  const want = new Set(classesOf(prefs));
  for (const name of ALL_CLASSES) root.classList.toggle(name, want.has(name));
}

export function isDefault(prefs: A11yPrefs): boolean {
  return classesOf(prefs).length === 0;
}

/** The browser's storage, or null when there is none or it throws (a private window, blocked site data). */
function storageOrNull(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Anything stored that is not a known value falls back to the default for that setting: a stale or hand-edited value never breaks the page. */
export function parsePrefs(raw: unknown): A11yPrefs {
  const o = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const flag = (key: keyof A11yPrefs): boolean => o[key] === true;
  return {
    textSize: o.textSize === 1 || o.textSize === 2 ? o.textSize : 0,
    contrast: flag('contrast'),
    links: flag('links'),
    font: flag('font'),
    motion: flag('motion'),
    focus: flag('focus'),
    spacing: flag('spacing'),
  };
}

export function readPrefs(storage: Storage | null = storageOrNull()): A11yPrefs {
  try {
    const text = storage?.getItem(A11Y_STORAGE_KEY);
    return text ? parsePrefs(JSON.parse(text)) : { ...DEFAULT_PREFS };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

/** Keeps `prefs` for next time (nothing is kept for the defaults: a reset leaves no trace). */
export function writePrefs(prefs: A11yPrefs, storage: Storage | null = storageOrNull()): void {
  try {
    if (isDefault(prefs)) storage?.removeItem(A11Y_STORAGE_KEY);
    else storage?.setItem(A11Y_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Storage is full, blocked or gone: the choice still holds for this page view.
  }
}

/** Before the first paint (main.tsx): the saved choices are on <html> already, so the page never flashes in the wrong size or contrast. */
export function applyStoredPrefs(): void {
  applyPrefs(readPrefs());
}
