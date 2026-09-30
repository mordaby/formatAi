import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider, type Lang } from '../src/i18n';
import { ACCEPTED_EXTENSIONS, DropZone, isAcceptedFile, type DropRejection, type DropZoneInfo } from '../src/ui';

afterEach(cleanup);

const file = (name: string, size = 10) => new File([new Uint8Array(size)], name);

function Harness({ info, onFile, onReject, maxBytes, lang = 'en' }: { info?: DropZoneInfo; onFile?: (f: File) => void; onReject?: (r: DropRejection) => void; maxBytes?: number; lang?: Lang }) {
  const [current, setCurrent] = useState<File | null>(null);
  return (
    <I18nProvider initial={lang}>
      <DropZone
        label="Example input"
        caption="A file as it arrives"
        file={current}
        info={info}
        onFile={(f) => {
          setCurrent(f);
          onFile?.(f);
        }}
        onClear={() => setCurrent(null)}
        onReject={onReject}
        maxBytes={maxBytes}
      />
    </I18nProvider>
  );
}

describe('DropZone', () => {
  it('knows the accepted types (SPEC 6.1) whatever their case', () => {
    expect(ACCEPTED_EXTENSIONS).toEqual(['.xlsx', '.xls', '.csv', '.txt']);
    for (const name of ['a.xlsx', 'a.XLS', 'report.final.csv', 'דוח.txt']) expect(isAcceptedFile(name)).toBe(true);
    for (const name of ['a.pdf', 'a.docx', 'a.xlsm', 'csv', 'a.csv.exe']) expect(isAcceptedFile(name)).toBe(false);
  });

  it('takes a file chosen with the browse dialog and reports it', () => {
    const onFile = vi.fn();
    render(<Harness onFile={onFile} />);
    const input = screen.getByLabelText('Example input') as HTMLInputElement;
    expect(input.getAttribute('accept')).toBe('.xlsx,.xls,.csv,.txt');
    const f = file('payments.csv');
    fireEvent.change(input, { target: { files: [f] } });
    expect(onFile).toHaveBeenCalledWith(f);
    expect(screen.getByText('payments.csv')).toBeTruthy();
  });

  it('takes a dropped file and reports it', () => {
    const onFile = vi.fn();
    render(<Harness onFile={onFile} />);
    const target = document.querySelector('.dz__target') as HTMLElement;
    const f = file('orders.xlsx');
    fireEvent.drop(target, { dataTransfer: { files: [f], types: ['Files'] } });
    expect(onFile).toHaveBeenCalledWith(f);
  });

  it('turns away a type it cannot read, says why, and reports the rejection', () => {
    const onFile = vi.fn();
    const onReject = vi.fn();
    render(<Harness onFile={onFile} onReject={onReject} />);
    const target = document.querySelector('.dz__target') as HTMLElement;
    const pdf = file('scan.pdf');
    fireEvent.drop(target, { dataTransfer: { files: [pdf], types: ['Files'] } });
    expect(onFile).not.toHaveBeenCalled();
    expect(onReject).toHaveBeenCalledWith({ kind: 'type', file: pdf });
    expect(screen.getByRole('alert').textContent).toContain('We can read .xlsx, .xls, .csv and .txt files.');

    // A good file afterwards clears the message.
    fireEvent.drop(target, { dataTransfer: { files: [file('ok.csv')], types: ['Files'] } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(onFile).toHaveBeenCalledTimes(1);
  });

  it('turns away a file over the size limit, with the sizes', () => {
    const onReject = vi.fn();
    render(<Harness onReject={onReject} maxBytes={5 * 1024 * 1024} />);
    const big = file('big.csv', 6 * 1024 * 1024);
    fireEvent.change(screen.getByLabelText('Example input'), { target: { files: [big] } });
    expect(onReject).toHaveBeenCalledWith({ kind: 'size', file: big, maxBytes: 5 * 1024 * 1024 });
    expect(screen.getByRole('alert').textContent).toBe('This file is too large (6.0 MB). Files can be up to 5 MB.');
  });

  it('reacts while a file is dragged over it, and stops when it leaves', () => {
    render(<Harness />);
    const zone = document.querySelector('.dz') as HTMLElement;
    const target = zone.querySelector('.dz__target') as HTMLElement;
    expect(zone.getAttribute('data-dragging')).toBeNull();
    fireEvent.dragEnter(target, { dataTransfer: { types: ['Files'] } });
    expect(zone.getAttribute('data-dragging')).toBe('true');
    expect(screen.getByText('Release to add this file')).toBeTruthy();
    fireEvent.dragLeave(target);
    expect(zone.getAttribute('data-dragging')).toBeNull();
  });

  it('settles the dropped file in with its name, then its rows and columns once they are known', () => {
    const { rerender } = render(<Harness info={{ status: 'reading' }} />);
    fireEvent.change(screen.getByLabelText('Example input'), { target: { files: [file('payments.csv')] } });
    expect(screen.getByText('Reading…')).toBeTruthy();
    rerender(<Harness info={{ status: 'ready', rows: 1204, columns: 8 }} />);
    expect(screen.getByText('1,204 rows')).toBeTruthy();
    expect(screen.getByText('8 columns')).toBeTruthy();
    expect(screen.queryByText('Reading…')).toBeNull();
  });

  it('counts in Hebrew, with singular forms', () => {
    const { rerender } = render(<Harness lang="he" info={{ status: 'ready', rows: 1, columns: 1 }} />);
    fireEvent.change(screen.getByLabelText('Example input'), { target: { files: [file('a.csv')] } });
    expect(screen.getByText('שורה אחת')).toBeTruthy();
    expect(screen.getByText('עמודה אחת')).toBeTruthy();
    rerender(<Harness lang="he" info={{ status: 'ready', rows: 12, columns: 3 }} />);
    expect(screen.getByText('12 שורות')).toBeTruthy();
    expect(screen.getByText('3 עמודות')).toBeTruthy();
  });

  it('says so when the worker cannot read the file', () => {
    render(<Harness info={{ status: 'unreadable' }} />);
    fireEvent.change(screen.getByLabelText('Example input'), { target: { files: [file('locked.xlsx')] } });
    expect(screen.getByRole('alert').textContent).toContain("We couldn't read this file.");
  });

  it('can be emptied again with the remove button', () => {
    render(<Harness />);
    fireEvent.change(screen.getByLabelText('Example input'), { target: { files: [file('payments.csv')] } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove Example input' }));
    expect(screen.queryByText('payments.csv')).toBeNull();
    expect(screen.getByText('browse')).toBeTruthy();
  });

  it('is a keyboard target: the file input is a real, focusable control inside the zone', () => {
    render(<Harness />);
    const input = screen.getByLabelText('Example input') as HTMLInputElement;
    expect(input.type).toBe('file');
    expect(input.tabIndex).not.toBe(-1);
    expect(input.closest('label')?.classList.contains('dz__target')).toBe(true);
  });
});
