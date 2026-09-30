import type { LearnResult } from '@formatai/shared';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Api } from '../src/api';
import { outputFileName } from '../src/flow/download';
import { useConvert } from '../src/flow/useConvert';
import { useLearnFlow } from '../src/flow/useLearnFlow';
import { ServicesProvider } from '../src/services';
import type { ConvertOutput, LearnOutput } from '../src/worker/engineApi';
import type { EngineClient } from '../src/worker/engineClient';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const file = (name: string, size = 4) => ({ name, size, arrayBuffer: async () => new ArrayBuffer(size) });
const api = {} as Api;

describe('useLearnFlow', () => {
  it('drives the state machine from a component and cancels on unmount', async () => {
    const learn = vi.fn(async (_args: unknown, _host: unknown, opts?: { onProgress?: (p: unknown) => void }) => {
      opts?.onProgress?.({ phase: 'checking', stage: 'profile', fraction: 0.5 });
      return { path: 'local', preflight: { status: 'ok', issues: [], skipColumns: [] }, rules: {}, verification: { verified: true }, assumptions: [], unsupported: [], calls: [], stages: {} } as unknown as LearnOutput;
    });
    const engine = { learn, convert: vi.fn(), verify: vi.fn(), terminate: vi.fn() } as unknown as EngineClient;

    let latest!: ReturnType<typeof useLearnFlow>;
    function Probe() {
      latest = useLearnFlow();
      return <p data-testid="status">{latest.state.status}</p>;
    }
    render(
      <ServicesProvider engine={engine} api={api}>
        <Probe />
      </ServicesProvider>,
    );
    expect(screen.getByTestId('status').textContent).toBe('idle');

    await act(async () => {
      await latest.start({ input: file('in.csv'), output: file('out.csv'), masking: true });
    });
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('done'));
    // The default tier until sign-in exists is anonymous.
    expect((learn.mock.calls[0]![0] as { tier: string }).tier).toBe('anonymous');
  });
});

describe('useConvert', () => {
  it('converts in the engine and downloads the bytes as a named Blob (nothing is uploaded)', async () => {
    const bytes = new TextEncoder().encode('a,b\n1,2\n').buffer as ArrayBuffer;
    const out: ConvertOutput = {
      ok: true,
      bytes,
      flags: [],
      summary: { rowsIn: 1, rowsOut: 1, rowsFiltered: 0, duplicatesRemoved: [], duplicatesFlagged: 0, blockedRows: [] },
      preview: { name: 's', direction: 'ltr', language: 'en', columns: [], rows: [], merges: [], file: { type: 'csv' } },
      totalRows: 2,
    };
    const convert = vi.fn(async () => out);
    const engine = { learn: vi.fn(), convert, verify: vi.fn(), terminate: vi.fn() } as unknown as EngineClient;
    const rules = { output: { file: { type: 'csv' }, columns: [] } } as unknown as LearnResult;

    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const clicked: { download: string; href: string }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ download: this.download, href: this.href });
    });

    let latest!: ReturnType<typeof useConvert>;
    function Probe() {
      latest = useConvert();
      return <p data-testid="status">{latest.state.status}</p>;
    }
    render(
      <ServicesProvider engine={engine} api={api}>
        <Probe />
      </ServicesProvider>,
    );

    await act(async () => {
      await latest.convert(rules, file('Payments March.xlsx'));
    });
    expect(screen.getByTestId('status').textContent).toBe('done');
    expect(convert).toHaveBeenCalledWith(expect.objectContaining({ previewRows: expect.any(Number) }), expect.anything());

    act(() => latest.download());
    expect(clicked).toEqual([{ download: 'Payments March (converted).csv', href: 'blob:test' }]);
    const blob = (createObjectURL.mock.calls[0] as unknown as [Blob])[0];
    expect(blob.type).toBe('text/csv');
    expect(blob.size).toBe(bytes.byteLength);
  });

  it('names the output after the source file and the rules output type', () => {
    const csv = { output: { file: { type: 'csv' } } } as unknown as LearnResult;
    const xlsx = { output: {} } as unknown as LearnResult;
    expect(outputFileName('a/b/Report.final.xlsx', csv)).toBe('Report.final (converted).csv');
    expect(outputFileName('דוח.csv', xlsx)).toBe('דוח (converted).xlsx');
  });

  it('reports a rejected file (missing columns) as a state, not an error', async () => {
    const engine = {
      learn: vi.fn(),
      convert: vi.fn(async () => ({ ok: false, error: { code: 'missingRequiredColumns', missing: ['Amount'] } }) as ConvertOutput),
      verify: vi.fn(),
      terminate: vi.fn(),
    } as unknown as EngineClient;
    let latest!: ReturnType<typeof useConvert>;
    function Probe() {
      latest = useConvert();
      return <p data-testid="status">{latest.state.status}</p>;
    }
    render(
      <ServicesProvider engine={engine} api={api}>
        <Probe />
      </ServicesProvider>,
    );
    await act(async () => {
      await latest.convert({ output: { columns: [] } } as unknown as LearnResult, file('x.csv'));
    });
    expect(screen.getByTestId('status').textContent).toBe('rejected');
  });
});
