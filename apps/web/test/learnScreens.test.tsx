import { limits } from '@formatai/shared';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api';
import { csv, fakeApi, fakeEngine, learnResult, PAYLOAD_SKIP, renderApp } from './helpers/renderApp';

beforeEach(() => {
  document.cookie = 'lang=; Path=/; Max-Age=0';
});
afterEach(() => {
  cleanup();
  document.cookie = 'lang=; Path=/; Max-Age=0';
});

async function dropBoth(): Promise<void> {
  fireEvent.change(screen.getByLabelText('Example input'), { target: { files: [csv('crm.csv')] } });
  fireEvent.change(screen.getByLabelText('Example output'), { target: { files: [csv('crm-out.csv')] } });
  // Both files are read by the worker; the rows and columns settle in.
  await waitFor(() => expect(screen.getAllByText('1,204 rows')).toHaveLength(2));
}

const learnButton = () => screen.getByRole('button', { name: /Learn the format/ }) as HTMLButtonElement;

describe('Home', () => {
  it('is the tool: two zones, the masking switch, the privacy line, one primary button, and how it works below', () => {
    renderApp();
    expect(screen.getByLabelText('Example input')).toBeTruthy();
    expect(screen.getByLabelText('Example output')).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'Masking' })).toBeTruthy();
    expect(screen.getByText('Your full files never leave your computer.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'See what we send' })).toBeTruthy();
    expect(learnButton().disabled).toBe(true);
    expect(screen.getByText('Add both files to continue.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'How it works' })).toBeTruthy();
    // The journey is visible: 1 Upload, 2 Learn, 3 Use, and we are on the first.
    const steps = screen.getByRole('list', { name: 'Steps' });
    expect(within(steps).getByText('Upload').closest('li')?.getAttribute('aria-current')).toBe('step');
  });

  it('shows what WILL be sent before a learn, and what was sent once there is a payload', () => {
    renderApp();
    fireEvent.click(screen.getByRole('button', { name: 'See what we send' }));
    // (a dialog since 2026-10-07: with no files yet it says what WILL go, and that the files show the exact rows)
    const panel = screen.getByRole('dialog', { name: 'See what we send' });
    expect(panel.textContent).toContain('Choose your two files to see the exact rows we would send');
    expect(panel.textContent).toContain(`Up to ${limits.payload.maxPairs} sample rows. Names, identifier numbers and other text are replaced with look-alike values first.`);
    fireEvent.click(screen.getByRole('switch', { name: 'Masking' }));
    expect(panel.textContent).toContain(`Up to ${limits.payload.maxPairs} sample rows, exactly as they are.`);
  });

  it('enables Learn only with both files, and shows their rows and columns', async () => {
    renderApp();
    fireEvent.change(screen.getByLabelText('Example input'), { target: { files: [csv('crm.csv')] } });
    await waitFor(() => expect(screen.getByText('1,204 rows')).toBeTruthy());
    expect(screen.getByText('8 columns')).toBeTruthy();
    expect(learnButton().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Example output'), { target: { files: [csv('crm-out.csv')] } });
    await waitFor(() => expect(learnButton().disabled).toBe(false));
  });

  it('keeps Learn off and explains when a file cannot be read', async () => {
    const { engine } = fakeEngine(undefined, () => ({ readable: false }));
    renderApp({ engine });
    fireEvent.change(screen.getByLabelText('Example input'), { target: { files: [csv('broken.xlsx')] } });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain("We couldn't read this file."));
    fireEvent.change(screen.getByLabelText('Example output'), { target: { files: [csv('out.csv')] } });
    await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(1));
    expect(learnButton().disabled).toBe(true);
  });

  it('fast path: learns with the files and masking choice, and lands on /result', async () => {
    const { engine, learn } = fakeEngine(async () => learnResult({ path: 'local' }));
    const api = fakeApi();
    renderApp({ engine, api });
    await dropBoth();
    fireEvent.click(screen.getByRole('switch', { name: 'Masking' })); // off
    await act(async () => {
      fireEvent.click(learnButton());
    });
    // The Result screen: the title is the format's name, which starts as the example output's file name.
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('crm-out'));
    expect(learn).toHaveBeenCalledTimes(1);
    const args = learn.mock.calls[0]![0] as { masking: boolean; input: { name: string }; output: { name: string }; tier: string };
    expect(args).toMatchObject({ masking: false, tier: 'anonymous', input: { name: 'crm.csv' }, output: { name: 'crm-out.csv' } });
    expect(api.learn).not.toHaveBeenCalled(); // no LLM call on the fast path
    expect(screen.getByText('Solved on your computer', { exact: false })).toBeTruthy();
    // "Use" is the current step now.
    expect(within(screen.getByRole('list', { name: 'Steps' })).getByText('Use').closest('li')?.getAttribute('aria-current')).toBe('step');
  });

  it('starting over from the result goes back to an empty Home', async () => {
    renderApp();
    await dropBoth();
    await act(async () => {
      fireEvent.click(learnButton());
    });
    await waitFor(() => screen.getByRole('button', { name: 'Start over' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start over' }));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Show us one example');
    expect(learnButton().disabled).toBe(true);
    expect(screen.queryByText('crm.csv')).toBeNull();
  });
});

describe('pre-flight (screen 2)', () => {
  it('unknown columns are no gate: no "One thing to check" screen, no Continue - the learn goes straight to the AI step', async () => {
    const { engine, learn } = fakeEngine(async (host) => {
      const r = await host.callLearn(PAYLOAD_SKIP);
      return learnResult({ path: 'llm', rules: r.rules });
    });
    const api = fakeApi();
    renderApp({ engine, api });
    await dropBoth();
    await act(async () => {
      fireEvent.click(learnButton());
    });

    await waitFor(() => expect(api.learn).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('heading', { name: 'One thing to check first' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
    await waitFor(() => screen.getByRole('button', { name: 'Start over' }));
    expect(learn).toHaveBeenCalledTimes(1);
  });

  it('rows not aligned: "Try anyway" runs the learn again, knowing the user said so', async () => {
    let call = 0;
    const { engine, learn } = fakeEngine(async () => {
      call += 1;
      if (call === 1) {
        return learnResult({ path: 'blocked', rules: null, verification: null, preflight: { status: 'warn', issues: [{ code: 'rowsNotAligned', severity: 'warn' }], skipColumns: [] } });
      }
      return learnResult({ path: 'llm' });
    });
    renderApp({ engine });
    await dropBoth();
    await act(async () => {
      fireEvent.click(learnButton());
    });
    await waitFor(() => screen.getByRole('button', { name: 'Try anyway' }));
    const status = screen.getByRole('status');
    expect(status.textContent).toContain('We couldn’t match rows between the two files. Are they from the same data?');
    expect(status.textContent).toContain('Trying anyway counts as a learn.');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try anyway' }));
    });
    await waitFor(() => screen.getByRole('button', { name: 'Start over' }));
    expect((learn.mock.calls[1]![0] as { tryAnyway?: boolean }).tryAnyway).toBe(true);
  });

  it('a block says exactly what is wrong and what to do, and never calls the server', async () => {
    const { engine } = fakeEngine(async () =>
      learnResult({
        path: 'blocked',
        rules: null,
        verification: null,
        preflight: {
          status: 'block',
          issues: [{ code: 'tableRejected', severity: 'block', params: { side: 'input', tableIssueCode: 'mergedHeader', row: 1, fromCol: 'B', toCol: 'D' } }],
          skipColumns: [],
        },
      }),
    );
    const api = fakeApi();
    renderApp({ engine, api });
    await dropBoth();
    await act(async () => {
      fireEvent.click(learnButton());
    });
    await waitFor(() => screen.getByRole('heading', { name: "We can't learn from these files" }));
    expect(screen.getByRole('alert').textContent).toBe('In the example input, row 1 has cells merged across columns B–D. Unmerge them and upload the file again.');
    expect(api.learn).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Choose other files' }));
    await waitFor(() => screen.getByRole('button', { name: /Learn the format/ }));
  });

  it('a block over the free limits offers to sign in', async () => {
    const { engine } = fakeEngine(async () =>
      learnResult({
        path: 'blocked',
        rules: null,
        verification: null,
        preflight: { status: 'block', issues: [{ code: 'overTierLimits', severity: 'block', params: { dimension: 'rows', value: 412, limit: 300 } }], skipColumns: [] },
      }),
    );
    renderApp({ engine });
    await dropBoth();
    await act(async () => {
      fireEvent.click(learnButton());
    });
    await waitFor(() => screen.getByRole('alert'));
    expect(screen.getByRole('alert').textContent).toBe('Your file has 412 rows, and the free plan allows up to 300. Use a smaller file, or sign in for a higher limit.');
    fireEvent.click(within(screen.getByRole('main')).getByRole('button', { name: 'Sign in' }));
    expect(screen.getByRole('dialog', { name: 'Sign in' })).toBeTruthy();
    expect(screen.getByText('Sign in to keep going.')).toBeTruthy();
  });

  it('reads in Hebrew too (the "rows could not be matched" screen; the info note about unknown columns is not part of it)', async () => {
    const { engine } = fakeEngine(async () =>
      learnResult({
        path: 'blocked',
        rules: null,
        verification: null,
        preflight: { status: 'warn', issues: [{ code: 'unknownOutputColumns', severity: 'info', params: { count: 1 } }, { code: 'rowsNotAligned', severity: 'warn' }], skipColumns: [] },
      }),
    );
    renderApp({ engine, lang: 'he' });
    fireEvent.change(screen.getByLabelText('דוגמת קלט'), { target: { files: [csv('a.csv')] } });
    fireEvent.change(screen.getByLabelText('דוגמת פלט'), { target: { files: [csv('b.csv')] } });
    await waitFor(() => expect((screen.getByRole('button', { name: /ללמוד את הפורמט/ }) as HTMLButtonElement).disabled).toBe(false));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /ללמוד את הפורמט/ }));
    });
    await waitFor(() => screen.getByRole('heading', { name: 'דבר אחד לבדוק קודם' }));
    expect(screen.getByRole('button', { name: 'נסו בכל זאת' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('לא הצלחנו להתאים שורות בין שני הקבצים.');
    expect(screen.getByRole('status').textContent).not.toContain('שלב ה-AI ינסה אותן');
  });
});

describe('API errors on the learn screen', () => {
  async function failWith(error: ApiError) {
    const api = fakeApi({ learn: vi.fn(async () => Promise.reject(error)) as never });
    const { engine } = fakeEngine(async (host) => {
      await host.callLearn(PAYLOAD_SKIP_NOSKIP);
      return learnResult({ path: 'llm' });
    });
    renderApp({ engine, api });
    await dropBoth();
    await act(async () => {
      fireEvent.click(learnButton());
    });
    await waitFor(() => screen.getByRole('button', { name: 'Change files' }));
  }

  it('limitHit shows the text of its own limit', async () => {
    await failWith(new ApiError('limitHit', 429, { limit: 'learnsPerDay' }));
    expect(screen.getByRole('status').textContent).toContain("You've used today's free tries. Come back tomorrow, or sign in to keep going.");
  });

  it('turnstileFailed asks for a refresh', async () => {
    await failWith(new ApiError('turnstileFailed', 403));
    expect(screen.getByRole('alert').textContent).toContain("We couldn't confirm you're not a robot.");
    expect(screen.getByRole('button', { name: 'Refresh the page' })).toBeTruthy();
  });

  it('a network failure can be retried with the same files', async () => {
    await failWith(new ApiError('network', 0));
    expect(screen.getByRole('alert').textContent).toContain("We couldn't reach the server.");
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Change files' }));
    await waitFor(() => screen.getByRole('button', { name: /Learn the format/ }));
    expect(screen.getByText('crm.csv')).toBeTruthy();
  });
});

// A payload without skipColumns, so the learn goes straight to the (failing) API call.
const PAYLOAD_SKIP_NOSKIP = { masking: true, output: { columns: [{ i: 0, header: 'A' }] }, samples: [] } as unknown as typeof PAYLOAD_SKIP;
