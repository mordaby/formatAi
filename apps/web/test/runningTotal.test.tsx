// The one across-row option in the column editor: "Running total" in "How is it made?" (the owner's decision: every other window function is
// written in Advanced). The fields, the note when the rules remove duplicates, what it writes, and the sentence the rules map gives it.
import type { Rules } from '@formatai/shared';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ordersRules } from '../src/editor/testkit';
import { line, openLine, openResult } from './helpers/resultKit';

beforeEach(() => {
  document.cookie = 'lang=; Path=/; Max-Age=0';
});
afterEach(() => {
  cleanup();
  document.cookie = 'lang=; Path=/; Max-Age=0';
  document.documentElement.lang = '';
  document.documentElement.dir = '';
});

const panelOf = (name: string): HTMLElement => screen.getByRole('complementary', { name });
const select = (panel: HTMLElement, label: string): HTMLSelectElement => within(panel).getByLabelText(label) as HTMLSelectElement;

function withDedupe(action: 'remove' | 'flag'): Rules {
  const r = ordersRules();
  return { ...r, transform: { ...r.transform, dedupe: { keys: ['sku'], keep: 'first', action } } };
}

describe('the Running total method in the column editor', () => {
  it('is one of the ways a column is made, with the three fields: what to add up, start again for each, and the order (required)', async () => {
    await openResult();
    openLine('col:Remarks');
    const panel = panelOf('Remarks');
    const chips = within(panel).getAllByRole('radio').map((r) => (r.nextElementSibling as HTMLElement).textContent);
    expect(chips).toEqual(['Copy a column', 'Calculate', 'Join text', 'Part of text', 'Translate values', 'Fixed value', 'Running total', 'Leave empty']);

    fireEvent.click(within(panel).getByRole('radio', { name: 'Running total' }));
    // the first number column, one total for all the rows, in the file's order
    expect(select(panel, 'The column to add up').value).toBe('qty');
    expect(select(panel, 'Start again for each (optional)').value).toBe('#none');
    expect(select(panel, 'Add the rows up in the order of').value).toBe('#file');
    // no direction while the order is the file's own
    expect(within(panel).queryByRole('radio', { name: 'Lowest first' })).toBeNull();

    // the column shows what it does, in plain words
    await waitFor(() => expect(line('col:Remarks').textContent).toContain('running total of Qty, in file order'));
    expect(line('col:Remarks').getAttribute('data-status')).toBe('edited');
  });

  it('the group, the order column and its direction change what it writes', async () => {
    const { liveCheck } = await openResult();
    openLine('col:Remarks');
    const panel = panelOf('Remarks');
    fireEvent.click(within(panel).getByRole('radio', { name: 'Running total' }));

    fireEvent.change(select(panel, 'The column to add up'), { target: { value: 'price' } });
    fireEvent.change(select(panel, 'Start again for each (optional)'), { target: { value: 'supplier' } });
    fireEvent.change(select(panel, 'Add the rows up in the order of'), { target: { value: 'col:shipped' } });
    // a direction appears once a column orders the rows; the default is lowest first
    expect((within(panel).getByRole('radio', { name: 'Lowest first' }) as HTMLInputElement).checked).toBe(true);
    await waitFor(() => expect(line('col:Remarks').textContent).toContain('running total of Unit price per Supplier, in order of Shipped'));

    fireEvent.click(within(panel).getByRole('radio', { name: 'Highest first' }));
    await waitFor(() => expect(line('col:Remarks').textContent).toContain('in order of Shipped (descending)'));
    const made = (): { expr: unknown; type: string } | undefined => {
      const rules = liveCheck.mock.calls.at(-1)![1] as Rules;
      return rules.transform.computed.find((c) => c.id === rules.output.columns[5]!.from);
    };
    await waitFor(() => expect(made()?.expr).toEqual({ op: 'window', fn: 'runningSum', arg: { col: 'price' }, by: ['supplier'], order: [{ column: 'shipped', dir: 'desc' }] }));
    expect(made()!.type).toBe('decimal');

    // back to the file's order: no order: in the rules, and no direction on the screen
    fireEvent.change(select(panel, 'Add the rows up in the order of'), { target: { value: '#file' } });
    await waitFor(() => expect(within(panel).queryByRole('radio', { name: 'Highest first' })).toBeNull());
    await waitFor(() => expect(made()?.expr).toEqual({ op: 'window', fn: 'runningSum', arg: { col: 'price' }, by: ['supplier'] }));
  });

  it('says duplicates are removed first when the rules remove duplicates, and only then', async () => {
    const note = 'Duplicates are removed before the total is calculated.';
    await openResult({ rules: withDedupe('remove') });
    openLine('col:Remarks');
    fireEvent.click(within(panelOf('Remarks')).getByRole('radio', { name: 'Running total' }));
    expect(within(panelOf('Remarks')).getByText(note)).toBeTruthy();
    cleanup();

    // flagged duplicates stay in the file (and in the total): nothing to say
    await openResult({ rules: withDedupe('flag') });
    openLine('col:Remarks');
    fireEvent.click(within(panelOf('Remarks')).getByRole('radio', { name: 'Running total' }));
    expect(within(panelOf('Remarks')).queryByText(note)).toBeNull();
    cleanup();

    await openResult();
    openLine('col:Remarks');
    fireEvent.click(within(panelOf('Remarks')).getByRole('radio', { name: 'Running total' }));
    expect(within(panelOf('Remarks')).queryByText(note)).toBeNull();
  });

  it('a column that already has a running total opens as that choice, with its fields filled in', async () => {
    const r = ordersRules();
    const rules: Rules = {
      ...r,
      transform: {
        ...r.transform,
        computed: [...r.transform.computed, { id: 'running', type: 'decimal', expr: { op: 'window', fn: 'runningSum', arg: { col: 'price' }, by: ['supplier'], order: [{ column: 'shipped', dir: 'desc' }] } }],
      },
      output: { ...r.output, columns: r.output.columns.map((c) => (c.header === 'Remarks' ? { ...c, from: 'running' } : c)) },
      unsupported: [],
    };
    await openResult({ rules });
    openLine('col:Remarks');
    const panel = panelOf('Remarks');
    expect((within(panel).getByRole('radio', { name: 'Running total' }) as HTMLInputElement).checked).toBe(true);
    expect(select(panel, 'The column to add up').value).toBe('price');
    expect(select(panel, 'Start again for each (optional)').value).toBe('supplier');
    expect(select(panel, 'Add the rows up in the order of').value).toBe('col:shipped');
    expect((within(panel).getByRole('radio', { name: 'Highest first' }) as HTMLInputElement).checked).toBe(true);
  });

  it('a running total the editor does not build (a rank, a group total) opens in Advanced as a formula', async () => {
    const r = ordersRules();
    const rules: Rules = {
      ...r,
      transform: { ...r.transform, computed: [...r.transform.computed, { id: 'rank', type: 'integer', expr: { op: 'window', fn: 'rank', order: [{ column: 'qty', dir: 'desc' }] } }] },
      output: { ...r.output, columns: r.output.columns.map((c) => (c.header === 'Remarks' ? { ...c, from: 'rank' } : c)) },
      unsupported: [],
    };
    await openResult({ rules });
    openLine('col:Remarks');
    const panel = panelOf('Remarks');
    expect((within(panel).getByRole('radio', { name: 'Formula' }) as HTMLInputElement).checked).toBe(true);
    expect((within(panel).getByRole('textbox', { name: 'Formula' }) as HTMLInputElement).value).toBe('rank(order: qty desc)');
    // and the rules map still says it in words
    expect(line('col:Remarks').textContent).toContain('rank by Qty (descending), equal values share a rank');
  });
});

describe('the Running total method, in Hebrew', () => {
  it('has its own name and fields', async () => {
    await openResult({ lang: 'he' });
    openLine('col:Remarks');
    const panel = panelOf('Remarks');
    fireEvent.click(within(panel).getByRole('radio', { name: 'סכום מצטבר' }));
    expect(select(panel, 'העמודה לסיכום')).toBeTruthy();
    expect(select(panel, 'להתחיל מחדש עבור כל (לא חובה)').value).toBe('#none');
    expect(select(panel, 'לסכם את השורות לפי הסדר של').value).toBe('#file');
    await waitFor(() => expect(line('col:Remarks').textContent).toContain('סכום מצטבר של'));
  });
});
