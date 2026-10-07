// "See what we send" before the learn (owner, 2026-10-07): Home's link opens a dialog with the sample rows as they will go, built by the
// real worker methods (in-process, through the real RPC), and a switch per column - Hidden / Sent as is, preset by the classification. A
// flip re-renders the rows at once, warns when an identifier is un-hidden, says what hiding real numbers may cost and what else moved with
// it, and the next learn carries the choice. Masking off disables the switches; another file resets the choices. English and Hebrew.
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LearnArgs } from '../src/worker/engineApi';
import { createEngineClient } from '../src/worker/engineClient';
import { engineMethods } from '../src/worker/engineMethods';
import { loopbackWorker } from './helpers/loopback';
import { csv, fakeEngine, learnResult, renderApp } from './helpers/renderApp';
import { IDS, idPair, NAMES, QTY } from './helpers/sendPreviewKit';

beforeEach(() => {
  document.cookie = 'lang=; Path=/; Max-Age=0';
});
afterEach(() => {
  cleanup();
  document.cookie = 'lang=; Path=/; Max-Age=0';
});

const COPY = {
  en: {
    input: 'Example input',
    output: 'Example output',
    see: 'See what we send',
    masking: 'Masking',
    learn: /Learn the format/,
    hidden: (c: string) => `${c}: hidden`,
    in: (c: string) => `${c} (input)`,
    out: (c: string) => `${c} (output)`,
    state: { hidden: 'Hidden', sent: 'Sent as is' },
    warnId: 'ID (input) looks like ID numbers; they will be sent as they are.',
    linked: 'Also changed: ID (output). They hold the same values, so they are hidden or sent together.',
    hideQty: 'Qty will be hidden. The AI may then be unable to learn rules that need its real numbers.',
    offNote: 'Turn masking on to choose which columns are hidden.',
    turnOn: 'Turn masking on',
    close: 'Close',
  },
  he: {
    input: 'דוגמת קלט',
    output: 'דוגמת פלט',
    see: 'מה אנחנו שולחים',
    masking: 'הסתרת נתונים',
    learn: /ללמוד את הפורמט/,
    hidden: (c: string) => `${c}: מוסתר`,
    in: (c: string) => `${c} (קלט)`,
    out: (c: string) => `${c} (פלט)`,
    state: { hidden: 'מוסתר', sent: 'נשלח כמו שהוא' },
    warnId: 'בעמודה ID (קלט) יש כנראה מספרי זהות; הם יישלחו כפי שהם.',
    linked: 'השתנו גם: ID (פלט). יש בהן אותם ערכים, ולכן הן מוסתרות או נשלחות יחד.',
    hideQty: 'העמודה Qty תוסתר. ייתכן שה-AI לא יוכל ללמוד כללים שצריכים את המספרים האמיתיים שלה.',
    offNote: 'כדי לבחור אילו עמודות להסתיר, הפעילו את הסתרת הנתונים.',
    turnOn: 'הפעלת הסתרת נתונים',
    close: 'סגירה',
  },
} as const;

describe.each(['en', 'he'] as const)('See what we send, before the learn (%s)', (lang) => {
  const c = COPY[lang];

  async function setup() {
    // The real worker methods build the preview (the learn itself is a fake: what it is asked is what matters here).
    const real = createEngineClient({ createWorker: () => loopbackWorker(engineMethods) });
    const { engine, learn } = fakeEngine(async () => learnResult(), undefined, { sendPreview: real.sendPreview });
    renderApp({ engine, lang });
    const pair = idPair();
    fireEvent.change(screen.getByLabelText(c.input), { target: { files: [csv('in.csv', pair.input)] } });
    fireEvent.change(screen.getByLabelText(c.output), { target: { files: [csv('out.csv', pair.output)] } });
    await waitFor(() => expect(screen.getAllByText(/1,204/)).toHaveLength(2));
    return { learn };
  }
  async function open() {
    fireEvent.click(screen.getByRole('button', { name: c.see }));
    const dialog = await screen.findByRole('dialog', { name: c.see });
    await within(dialog).findByRole('switch', { name: c.hidden(c.in('ID')) });
    return dialog;
  }
  const toggle = (dialog: HTMLElement, column: string) => within(dialog).getByRole('switch', { name: c.hidden(column) }) as HTMLInputElement;
  /** The values the table shows in one column of the first table (0: ID, 1: Name, 2: Qty; then the output's). */
  const column = (dialog: HTMLElement, k: number): string[] =>
    [...dialog.querySelectorAll('.send-preview__table')[0]!.querySelectorAll('tbody tr')].map((tr) => tr.querySelectorAll('td')[k]?.textContent ?? '');

  it('shows the sample rows as they go: IDs and names hidden (look-alikes), quantities real; each column a labelled switch', async () => {
    await setup();
    const dialog = await open();
    expect(toggle(dialog, c.in('ID')).checked).toBe(true);
    expect(toggle(dialog, c.in('Name')).checked).toBe(true);
    expect(toggle(dialog, 'Qty').checked).toBe(false);
    expect(toggle(dialog, 'Size').checked).toBe(true); // text: hidden
    const ids = column(dialog, 0);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.some((v) => IDS.includes(v))).toBe(false);
    expect(column(dialog, 1).some((v) => NAMES.includes(v))).toBe(false);
    expect(column(dialog, 2).every((v) => QTY.map(String).includes(v))).toBe(true);
    // The state in words beside each switch.
    expect(within(dialog).getAllByText(c.state.hidden).length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText(c.state.sent).length).toBeGreaterThan(0);
  });

  it('a flip re-renders the rows at once, warns about the IDs, says the copy moved with it, and the next learn carries the choice', async () => {
    const { learn } = await setup();
    const dialog = await open();
    fireEvent.click(toggle(dialog, c.in('ID')));
    await waitFor(() => expect(column(dialog, 0).every((v) => IDS.includes(v))).toBe(true));
    expect(toggle(dialog, c.in('ID')).checked).toBe(false);
    await within(dialog).findByText(c.warnId);
    expect(within(dialog).getByText(c.linked)).toBeTruthy();
    // The output's copy of the IDs went with it.
    expect(toggle(dialog, c.out('ID')).checked).toBe(false);
    expect(toggle(dialog, c.out('Name')).checked).toBe(true);

    fireEvent.click(within(dialog).getByRole('button', { name: c.close }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: c.learn }));
    });
    await waitFor(() => expect(learn).toHaveBeenCalled());
    expect((learn.mock.calls[0]![0] as LearnArgs).columnChoices).toEqual({ input: { 0: 'sent' }, output: { 0: 'sent' } });
  });

  it('hiding a measure is allowed, re-renders it hidden, and says the AI may then miss rules on its real numbers', async () => {
    await setup();
    const dialog = await open();
    fireEvent.click(toggle(dialog, 'Qty'));
    await waitFor(() => expect(toggle(dialog, 'Qty').checked).toBe(true));
    await within(dialog).findByText(c.hideQty);
    expect(column(dialog, 2).filter((v) => QTY.map(String).includes(v)).length).toBeLessThan(column(dialog, 2).length);
    expect(within(dialog).queryByText(c.warnId)).toBeNull();
  });

  it('masking off: every column is sent as it is, the switches are off and disabled, with the way to turn masking on', async () => {
    await setup();
    const dialog = await open();
    fireEvent.click(screen.getByRole('switch', { name: c.masking }));
    await within(dialog).findByText(c.offNote);
    await waitFor(() => expect(column(dialog, 0).every((v) => IDS.includes(v))).toBe(true));
    for (const name of [c.in('ID'), c.in('Name'), 'Qty']) {
      expect(toggle(dialog, name).checked).toBe(false);
      expect(toggle(dialog, name).disabled).toBe(true);
    }
    fireEvent.click(within(dialog).getByRole('button', { name: c.turnOn }));
    await waitFor(() => expect(toggle(dialog, c.in('ID')).disabled).toBe(false));
    expect(toggle(dialog, c.in('ID')).checked).toBe(true);
  });

  it('another file is a new example: the choices start again from none', async () => {
    const { learn } = await setup();
    let dialog = await open();
    fireEvent.click(toggle(dialog, c.in('ID')));
    await waitFor(() => expect(toggle(dialog, c.in('ID')).checked).toBe(false));
    fireEvent.click(within(dialog).getByRole('button', { name: c.close }));
    fireEvent.change(screen.getByLabelText(c.input), { target: { files: [csv('in2.csv', idPair().input)] } });
    dialog = await open();
    await waitFor(() => expect(toggle(dialog, c.in('ID')).checked).toBe(true));
    fireEvent.click(within(dialog).getByRole('button', { name: c.close }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: c.learn }));
    });
    await waitFor(() => expect(learn).toHaveBeenCalled());
    expect((learn.mock.calls[0]![0] as LearnArgs).columnChoices).toBeUndefined();
  });
});
