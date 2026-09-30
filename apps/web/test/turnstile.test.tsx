import { tiers } from '@formatai/shared';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Api } from '../src/api';
import { TurnstileProvider, TurnstileSlot, useTurnstile } from '../src/app/Turnstile';
import { TurnstileController, type TurnstileRenderOptions, type TurnstileWidgetApi } from '../src/app/turnstileController';
import { I18nProvider } from '../src/i18n';
import { ServicesProvider } from '../src/services';
import type { EngineClient } from '../src/worker/engineClient';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function fakeWidget() {
  let options: TurnstileRenderOptions | undefined;
  const api: TurnstileWidgetApi = {
    render: vi.fn((_c, o) => {
      options = o;
      return 'w1';
    }),
    reset: vi.fn(),
    remove: vi.fn(),
  };
  return { api, options: () => options! };
}

describe('TurnstileController', () => {
  it('renders an invisible-until-needed widget for the site key, in the UI language', async () => {
    const widget = fakeWidget();
    const controller = new TurnstileController({ siteKey: 'KEY', getLanguage: () => 'he', load: async () => widget.api });
    const box = document.createElement('div');
    controller.attach(box);
    await waitFor(() => expect(widget.api.render).toHaveBeenCalled());
    expect(widget.options()).toMatchObject({ sitekey: 'KEY', appearance: 'interaction-only', language: 'he' });
  });

  it('hands a token to the learn that waits for it, then asks for the next one (tokens are single-use)', async () => {
    const widget = fakeWidget();
    const controller = new TurnstileController({ siteKey: 'KEY', getLanguage: () => 'en', load: async () => widget.api });
    controller.attach(document.createElement('div'));
    await waitFor(() => expect(widget.api.render).toHaveBeenCalled());

    const pending = controller.getToken();
    widget.options().callback('token-1');
    await expect(pending).resolves.toBe('token-1');
    expect(widget.api.reset).toHaveBeenCalledWith('w1');

    // A token that arrived earlier is kept until asked for, and used once.
    widget.options().callback('token-2');
    await expect(controller.getToken()).resolves.toBe('token-2');
    vi.useFakeTimers();
    const again = controller.getToken();
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(again).resolves.toBeUndefined();
  });

  it('drops an expired token and gives up with no token when the script cannot load', async () => {
    const widget = fakeWidget();
    const controller = new TurnstileController({ siteKey: 'KEY', getLanguage: () => 'en', load: async () => widget.api, timeoutMs: 5 });
    controller.attach(document.createElement('div'));
    await waitFor(() => expect(widget.api.render).toHaveBeenCalled());
    widget.options().callback('old');
    widget.options()['expired-callback']?.();
    await expect(controller.getToken()).resolves.toBeUndefined();

    const broken = new TurnstileController({ siteKey: 'KEY', getLanguage: () => 'en', load: () => Promise.reject(new Error('blocked')) });
    broken.attach(document.createElement('div'));
    await expect(broken.getToken()).resolves.toBeUndefined();
  });

  it('removes the widget when detached', async () => {
    const widget = fakeWidget();
    const controller = new TurnstileController({ siteKey: 'KEY', getLanguage: () => 'en', load: async () => widget.api });
    const detach = controller.attach(document.createElement('div'));
    await waitFor(() => expect(widget.api.render).toHaveBeenCalled());
    detach();
    expect(widget.api.remove).toHaveBeenCalledWith('w1');
  });
});

describe('TurnstileProvider', () => {
  function setup(session: () => Promise<unknown>) {
    const api = { session: vi.fn(session), learn: vi.fn(), repair: vi.fn() } as unknown as Api;
    let token: ReturnType<typeof useTurnstile>['getToken'] | undefined;
    function Probe() {
      token = useTurnstile().getToken;
      return <TurnstileSlot />;
    }
    render(
      <I18nProvider initial="en">
        <ServicesProvider api={api} engine={{} as EngineClient}>
          <TurnstileProvider>
            <Probe />
          </TurnstileProvider>
        </ServicesProvider>
      </I18nProvider>,
    );
    return { api, getToken: () => token!() };
  }

  it('loads no script and gives no token when the session has no site key (dev)', async () => {
    const appendChild = vi.spyOn(document.head, 'appendChild');
    const { api, getToken } = setup(async () => ({ anonId: true, tier: 'free', limits: tiers.anonymous }));
    await waitFor(() => expect(api.session).toHaveBeenCalled());
    await expect(getToken()).resolves.toBeUndefined();
    expect(appendChild.mock.calls.some(([node]) => (node as HTMLElement).tagName === 'SCRIPT')).toBe(false);
    expect(screen.queryByText(/challenges\.cloudflare\.com/)).toBeNull();
    appendChild.mockRestore();
  });

  it('gives no token, and does not break, when the API cannot be reached', async () => {
    const { getToken } = setup(() => Promise.reject(new Error('offline')));
    await expect(getToken()).resolves.toBeUndefined();
  });

  it("with a site key, loads Cloudflare's script (and only then)", async () => {
    // Record the script tag without really adding it (nothing is fetched in a test).
    const appendChild = vi.spyOn(document.head, 'appendChild').mockImplementation((node) => node);
    setup(async () => ({ anonId: true, tier: 'free', limits: tiers.anonymous, turnstileSiteKey: 'SITE' }));
    await act(async () => {});
    await waitFor(() => expect(appendChild.mock.calls.some(([node]) => (node as HTMLScriptElement).src?.startsWith('https://challenges.cloudflare.com/turnstile/v0/api.js'))).toBe(true));
    appendChild.mockRestore();
  });
});
