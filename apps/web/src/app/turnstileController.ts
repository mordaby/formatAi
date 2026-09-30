// Cloudflare Turnstile (SPEC 9.5): the anti-bot check in front of /api/learn. Framework-free so
// it can be tested with a fake widget API. Nothing is loaded unless `/api/session` returns a site
// key; without one (local dev) learns simply skip the check.

export interface TurnstileRenderOptions {
  sitekey: string;
  callback(token: string): void;
  'expired-callback'?(): void;
  'timeout-callback'?(): void;
  'error-callback'?(): void;
  /** interaction-only: the widget stays invisible unless Cloudflare needs the visitor to do something. */
  appearance?: 'always' | 'execute' | 'interaction-only';
  size?: 'normal' | 'flexible' | 'compact';
  theme?: 'auto' | 'light' | 'dark';
  language?: string;
}

export interface TurnstileWidgetApi {
  render(container: HTMLElement, options: TurnstileRenderOptions): string;
  reset(widgetId: string): void;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileWidgetApi;
  }
}

export const TURNSTILE_SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

let scriptPromise: Promise<TurnstileWidgetApi> | undefined;

/** Loads Cloudflare's script once, on demand. */
export function loadTurnstile(): Promise<TurnstileWidgetApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  scriptPromise ??= new Promise<TurnstileWidgetApi>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = TURNSTILE_SCRIPT_URL;
    script.async = true;
    script.defer = true;
    script.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('Turnstile did not start')));
    script.onerror = () => {
      scriptPromise = undefined;
      script.remove();
      reject(new Error('Turnstile could not be loaded'));
    };
    document.head.appendChild(script);
  });
  return scriptPromise;
}

export interface TurnstileControllerOptions {
  siteKey: string;
  /** The UI language at render time ('he' | 'en'). */
  getLanguage(): string;
  /** Injectable for tests. */
  load?: () => Promise<TurnstileWidgetApi>;
  /** How long a learn waits for a token before it goes without one (the API then answers `turnstileFailed`). */
  timeoutMs?: number;
}

/**
 * One widget, one token at a time. A token is single-use, so after one is handed out the widget
 * is reset to get the next one in the background; an expired token is replaced the same way.
 */
export class TurnstileController {
  private api: TurnstileWidgetApi | undefined;
  private widgetId: string | undefined;
  private token: string | undefined;
  private waiters: Array<(token: string | undefined) => void> = [];

  constructor(private readonly options: TurnstileControllerOptions) {}

  /** Renders the widget into `container`. Returns the cleanup. */
  attach(container: HTMLElement): () => void {
    let cancelled = false;
    let api: TurnstileWidgetApi | undefined;
    let widgetId: string | undefined;
    const load = this.options.load ?? loadTurnstile;
    load().then(
      (loaded) => {
        if (cancelled) return;
        api = loaded;
        widgetId = loaded.render(container, {
          sitekey: this.options.siteKey,
          appearance: 'interaction-only',
          size: 'flexible',
          theme: 'auto',
          language: this.options.getLanguage(),
          callback: (token) => this.receive(token),
          'expired-callback': () => {
            this.token = undefined;
            this.reset();
          },
          'timeout-callback': () => this.reset(),
          'error-callback': () => this.settleWaiters(undefined),
        });
        this.api = loaded;
        this.widgetId = widgetId;
      },
      () => this.settleWaiters(undefined),
    );
    return () => {
      cancelled = true;
      if (api && widgetId !== undefined) api.remove(widgetId);
      if (this.widgetId === widgetId) {
        this.api = undefined;
        this.widgetId = undefined;
        this.token = undefined;
      }
    };
  }

  /** A fresh token for one learn call, or `undefined` when none arrives in time. */
  getToken(): Promise<string | undefined> {
    if (this.token) {
      const token = this.token;
      this.token = undefined;
      this.reset();
      return Promise.resolve(token);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        resolve(undefined);
      }, this.options.timeoutMs ?? 20_000);
      const waiter = (token: string | undefined): void => {
        clearTimeout(timer);
        resolve(token);
      };
      this.waiters.push(waiter);
    });
  }

  private receive(token: string): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(token);
      this.reset();
    } else {
      this.token = token;
    }
  }

  private settleWaiters(token: string | undefined): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w(token);
  }

  private reset(): void {
    if (this.api && this.widgetId !== undefined) this.api.reset(this.widgetId);
  }
}
