// /batch was the paid-only batch page; batch is part of the Run screen now (SPEC 21 v11), so the old address goes there, query string and all.
import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeApi, renderApp } from './helpers/renderApp';

afterEach(cleanup);

describe('/batch', () => {
  it('goes to /convert, keeping the query string', async () => {
    const { router } = renderApp({ route: '/batch?format=F1', api: fakeApi(), dataRouter: true });
    await screen.findByText('Sign in to run a format');
    expect(router!.state.location.pathname).toBe('/convert');
    expect(router!.state.location.search).toBe('?format=F1');
  });

  it('goes to plain /convert when there is none', async () => {
    const { router } = renderApp({ route: '/batch', api: fakeApi(), dataRouter: true });
    await screen.findByText('Sign in to run a format');
    expect(router!.state.location.pathname).toBe('/convert');
    expect(router!.state.location.search).toBe('');
  });
});
