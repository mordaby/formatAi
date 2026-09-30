import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Cell } from '../src/components/Cell';
import { SheetDirection } from '../src/components/SheetDirection';
import { I18nProvider } from '../src/i18n';

afterEach(() => {
  cleanup();
  document.documentElement.lang = '';
  document.documentElement.dir = '';
});

describe('<Cell> bidi isolation (SPEC 16.2 "Mixed text")', () => {
  it('wraps a value in <bdi>', () => {
    const { container } = render(<Cell value="שלום" />);
    const bdi = container.querySelector('bdi');
    expect(bdi).not.toBeNull();
    expect(bdi!.textContent).toBe('שלום');
  });

  it('keeps mixed Hebrew / Latin / digits together in ONE isolated run', () => {
    const { container } = render(
      <p>
        {'לקוח: '}
        <Cell value="ABC-123 שלום 45.50" />
        {' / '}
        <Cell value="ספק Acme" />
      </p>,
    );
    const runs = [...container.querySelectorAll('bdi')].map((b) => b.textContent);
    expect(runs).toEqual(['ABC-123 שלום 45.50', 'ספק Acme']);
  });

  it('does not force a direction: <bdi> picks it from the content (dir=auto by definition)', () => {
    const { container } = render(<Cell value="שלום" />);
    expect(container.querySelector('bdi')!.hasAttribute('dir')).toBe(false);
  });

  it('renders numbers and booleans as text', () => {
    const { container } = render(
      <>
        <Cell value={1234.5} />
        <Cell value={false} />
      </>,
    );
    expect([...container.querySelectorAll('bdi')].map((b) => b.textContent)).toEqual(['1234.5', 'false']);
  });

  it('renders nothing for empty values, or the placeholder when one is given', () => {
    const { container, rerender } = render(<Cell value={null} />);
    expect(container.innerHTML).toBe('');
    rerender(<Cell value="" />);
    expect(container.innerHTML).toBe('');
    rerender(<Cell value={undefined} empty="(empty)" />);
    expect(container.textContent).toBe('(empty)');
    expect(container.querySelector('bdi')).toBeNull();
  });

  it('does not interpret markup in a value (untrusted text, SPEC 15)', () => {
    const { container } = render(<Cell value={'<img src=x onerror=alert(1)>'} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('bdi')!.textContent).toBe('<img src=x onerror=alert(1)>');
  });
});

describe('<SheetDirection> (SPEC 16.2 "Sheet direction")', () => {
  it('a Hebrew (rtl) sheet renders right-to-left even in the English (ltr) UI', () => {
    render(
      <I18nProvider initial="en">
        <SheetDirection direction="rtl">
          <span data-testid="grid">
            <Cell value="שלום" />
          </span>
        </SheetDirection>
      </I18nProvider>,
    );
    expect(document.documentElement.dir).toBe('ltr');
    const wrapper = screen.getByTestId('grid').closest('[data-sheet-direction]') as HTMLElement;
    expect(wrapper.getAttribute('dir')).toBe('rtl');
    expect(wrapper.style.unicodeBidi).toBe('isolate');
  });

  it('an English (ltr) sheet stays left-to-right in the Hebrew (rtl) UI', () => {
    render(
      <I18nProvider initial="he">
        <SheetDirection direction="ltr">
          <span data-testid="grid">x</span>
        </SheetDirection>
      </I18nProvider>,
    );
    expect(document.documentElement.dir).toBe('rtl');
    expect((screen.getByTestId('grid').closest('[data-sheet-direction]') as HTMLElement).getAttribute('dir')).toBe('ltr');
  });
});
