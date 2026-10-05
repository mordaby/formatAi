// /dev: a plain, unstyled debug page for proving the plumbing (engine in the worker,
// the flow state machine, the API client). NOT the product UI: no design, English-only
// labels except where it shows real product text (messages, codes), and it is left out
// of production builds (see App.tsx).
import { printFormula } from '@formatai/engine/formula';
import type { LearnResult } from '@formatai/shared';
import { useCallback, useRef, useState } from 'react';
import { Cell } from '../components/Cell';
import { SheetDirection } from '../components/SheetDirection';
import { flowErrorText } from '../flow/errors';
import type { FileLike } from '../flow/learnFlow';
import { useConvert } from '../flow/useConvert';
import { useLearnFlow } from '../flow/useLearnFlow';
import { useI18n } from '../i18n';

const SAMPLE_CASE = 'crm-rename-reorder';

const SAMPLE_EXTENSIONS = ['csv', 'xlsx', 'xls', 'txt'];

/** eval/cases/<case>/<stem>.<ext> for the first extension that exists (dev server only), or null. */
async function fetchSample(caseName: string, stem: string): Promise<File | null> {
  for (const ext of SAMPLE_EXTENSIONS) {
    const name = `${stem}.${ext}`;
    const res = await fetch(`/__dev/cases/${encodeURIComponent(caseName)}/${name}`);
    if (res.ok) return new File([await res.arrayBuffer()], name);
  }
  return null;
}

function describe(f: FileLike | null): string {
  return f ? `${f.name} (${f.size} bytes)` : 'none';
}

export default function DevPage() {
  const i18n = useI18n();
  const { t, code } = i18n;
  // Safety: this page must not spend an LLM call by accident. The payload is still built and shown
  // ("See what we send"); the send itself waits for the checkbox.
  const [allowLlm, setAllowLlm] = useState(false);
  const allowLlmRef = useRef(allowLlm);
  allowLlmRef.current = allowLlm;
  const beforeSend = useCallback(() => {
    if (!allowLlmRef.current) throw new Error('Not sent: tick "Allow LLM call" on this page to send the payload shown below.');
  }, []);
  const flow = useLearnFlow({ beforeSend });
  const conv = useConvert();

  const [input, setInput] = useState<File | null>(null);
  const [output, setOutput] = useState<File | null>(null);
  const [source, setSource] = useState<File | null>(null);
  const [masking, setMasking] = useState(true);
  const [sampleCase, setSampleCase] = useState(SAMPLE_CASE);
  const [loadError, setLoadError] = useState<string | null>(null);

  const s = flow.state;
  const running = s.status === 'reading' || s.status === 'checking' || s.status === 'learning' || s.status === 'verifying';
  const rules: LearnResult | null = s.status === 'done' ? s.result.rules : null;

  async function loadSample(): Promise<void> {
    setLoadError(null);
    try {
      const [i, o, next] = await Promise.all([fetchSample(sampleCase, 'input'), fetchSample(sampleCase, 'output'), fetchSample(sampleCase, 'next.input')]);
      if (!i || !o) throw new Error(`No input/output pair in eval/cases/${sampleCase}`);
      setInput(i);
      setOutput(o);
      setSource(next);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <main>
      <h1>/dev (debug, not the product UI)</h1>

      <section>
        <h2>1. Example pair</h2>
        <p>
          <label>
            Example input <input type="file" data-testid="input-file" accept=".xlsx,.xls,.csv,.txt" onChange={(e) => setInput(e.target.files?.[0] ?? null)} />
          </label>{' '}
          <span data-testid="input-name">{describe(input)}</span>
        </p>
        <p>
          <label>
            Example output <input type="file" data-testid="output-file" accept=".xlsx,.xls,.csv,.txt" onChange={(e) => setOutput(e.target.files?.[0] ?? null)} />
          </label>{' '}
          <span data-testid="output-name">{describe(output)}</span>
        </p>
        <p>
          Sample case (dev server only) <input value={sampleCase} onChange={(e) => setSampleCase(e.target.value)} />{' '}
          <button type="button" data-testid="load-sample" onClick={() => void loadSample()}>
            Load sample case
          </button>{' '}
          {loadError && <span role="alert">{loadError}</span>}
        </p>
        <p>
          <label>
            <input type="checkbox" checked={masking} onChange={(e) => setMasking(e.target.checked)} data-testid="masking" /> {t('masking.label')}
          </label>
          <br />
          {masking ? t('masking.on') : t('masking.off')} {t('masking.always')}
        </p>
        <p>
          <label>
            <input type="checkbox" checked={allowLlm} onChange={(e) => setAllowLlm(e.target.checked)} data-testid="allow-llm" /> Allow LLM call (POST /api/learn; off = the payload is built and shown but not sent)
          </label>
        </p>
        <p>
          <button
            type="button"
            data-testid="run-learn"
            disabled={!input || !output || running}
            onClick={() => input && output && void flow.start({ input, output, masking })}
          >
            Run learn
          </button>{' '}
          <button type="button" onClick={flow.cancel} disabled={s.status === 'idle'}>
            {t('flow.cancel')}
          </button>
        </p>
      </section>

      <section>
        <h2>2. Status</h2>
        <p data-testid="status">status: {s.status}</p>
        {s.status === 'reading' && <p>{t('flow.reading')}</p>}
        {s.status === 'checking' && (
          <p>
            {t('flow.checking')}: {s.stage} <progress value={s.fraction} max={1} /> {Math.round(s.fraction * 100)}%
          </p>
        )}
        {s.status === 'learning' && (
          <p>
            {s.attempt === 'repair' ? t('flow.learningRepair') : t('flow.learning')}
            {s.unexplained && s.unexplained.length > 0 && <> ({s.unexplained.join(', ')})</>}
          </p>
        )}
        {s.status === 'verifying' && <p>{t('flow.verifying')}</p>}
        {s.status === 'error' && (
          <p role="alert" data-testid="error">
            {flowErrorText(i18n, s.error)}
            {s.error.kind === 'unexpected' && <> ({s.error.message})</>}
          </p>
        )}
        {s.status === 'warn' && (
          <div role="alert" data-testid="warn">
            {s.issues.map((i) => (
              <p key={i.code}>{code({ kind: 'preflight', code: i.code, ...(i.params ? { params: i.params } : {}) })}</p>
            ))}
            <button type="button" onClick={flow.confirm}>
              {t('flow.warn.tryAnyway')}
            </button>{' '}
            <button type="button" onClick={flow.cancel}>
              {t('flow.cancel')}
            </button>
          </div>
        )}
        {s.status === 'blocked' && (
          <div role="alert" data-testid="blocked">
            <p>{t('flow.blocked')}</p>
            <ul>
              {s.result.preflight.issues.map((i, n) => (
                <li key={n}>
                  {i.code}: {code({ kind: 'preflight', code: i.code, ...(i.params ? { params: i.params } : {}) })}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {s.status === 'done' && (
        <section data-testid="result">
          <h2>3. Result</h2>
          <p data-testid="path">
            path: <b>{s.result.path}</b> ({t(s.result.path === 'local' ? 'flow.path.local' : 'flow.path.llm')})
          </p>
          <p>
            pre-flight: {s.result.preflight.status}
            {s.result.preflight.issues.length > 0 && ` (${s.result.preflight.issues.map((i) => i.code).join(', ')})`}
          </p>
          {s.result.verification && (
            <p data-testid="verification">
              verification: <b>{s.result.verification.verified ? 'verified' : 'not verified'}</b> — {s.result.verification.matched}/{s.result.verification.total} rows
              match, {s.result.verification.mismatches.length} mismatches, {s.result.verification.layoutProblems.length} layout problems ({t(s.result.verification.verified ? 'flow.status.verified' : 'flow.status.notVerified')})
            </p>
          )}
          <p>
            stages: {Object.entries(s.result.stages).map(([k, v]) => `${k}=${String(v)}`).join(' ')}
          </p>
          {rules && <RulesSummary rules={rules} />}
          {s.result.unsupported.length > 0 && (
            <>
              <h3>Unsupported</h3>
              <ul>
                {s.result.unsupported.map((u, n) => (
                  <li key={n}>
                    <Cell value={u.outputColumn} /> — {code({ kind: 'unsupported', code: u.reasonCode })}
                  </li>
                ))}
              </ul>
            </>
          )}
          {s.result.assumptions.length > 0 && (
            <>
              <h3>Assumptions</h3>
              <ul>
                {s.result.assumptions.map((a, n) => (
                  <li key={n}>
                    <Cell value={a.outputColumn} /> — {code({ kind: 'assumption', code: a.reasonCode })}
                  </li>
                ))}
              </ul>
            </>
          )}
          {s.result.verification && s.result.verification.mismatches.length > 0 && (
            <>
              <h3>First mismatches</h3>
              <ul>
                {s.result.verification.mismatches.slice(0, 10).map((m, n) => (
                  <li key={n}>
                    row {m.exampleRow}, <Cell value={m.column} />: expected <Cell value={m.expected} empty="(empty)" />, got <Cell value={m.actual} empty="(empty)" />
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      <section>
        <h2>4. {t('sendPanel.title')}</h2>
        {s.sent.length === 0 && <p>{t('sendPanel.empty')}</p>}
        {s.sent.map((rec, n) => (
          <details key={n} data-testid="sent">
            <summary>
              {rec.kind}
              {rec.fresh ? ' (fresh, uncached)' : ''} — {t('sendPanel.size', { kb: (rec.bytes / 1024).toFixed(1) })}
            </summary>
            <pre dir="ltr">{JSON.stringify(rec.kind === 'learn' ? { payload: rec.payload } : rec.kind === 'step' ? { payload: rec.payload, rounds: rec.rounds } : { payload: rec.payload, previousRules: rec.previousRules, problems: rec.problems }, null, 2)}</pre>
          </details>
        ))}
        <p>{t('masking.always')}</p>
      </section>

      <section>
        <h2>5. {t('convert.title')}</h2>
        {!rules && <p>{t('convert.noRules')}</p>}
        <p>
          <input type="file" data-testid="convert-file" accept=".xlsx,.xls,.csv,.txt" onChange={(e) => setSource(e.target.files?.[0] ?? null)} />{' '}
          <span data-testid="convert-name">{describe(source)}</span>
        </p>
        <p>
          <button type="button" data-testid="run-convert" disabled={!rules || !source || conv.state.status === 'running'} onClick={() => rules && source && void conv.convert(rules, source)}>
            {t('convert.title')}
          </button>
        </p>
        <p data-testid="convert-status">convert: {conv.state.status}</p>
        {conv.state.status === 'error' && <p role="alert">{flowErrorText(i18n, conv.state.error)}</p>}
        {conv.state.status === 'rejected' && (
          <p role="alert">
            {conv.state.error.code}
            {conv.state.error.missing && `: ${t('convert.missingColumns', { columns: conv.state.error.missing.join(', ') })}`}
          </p>
        )}
        {conv.state.status === 'done' && (
          <div data-testid="convert-result">
            <p>
              {t('convert.rowsIn')}: {conv.state.result.summary.rowsIn}, {t('convert.rowsOut')}: {conv.state.result.summary.rowsOut}, {t('convert.flags')}: {conv.state.result.flags.length};
              file {conv.state.fileName}, <span data-testid="convert-bytes">{conv.state.result.bytes.byteLength}</span> bytes
            </p>
            <p>
              <button type="button" data-testid="download" onClick={conv.download}>
                {t('convert.download')}
              </button>
            </p>
            {conv.state.result.flags.length > 0 && (
              <ul>
                {conv.state.result.flags.slice(0, 20).map((f, n) => (
                  <li key={n}>
                    row {f.rowNumber}, <Cell value={f.column} />: {code({ kind: 'flag', code: f.messageKey, ...(f.params ? { params: f.params } : {}) })}
                  </li>
                ))}
              </ul>
            )}
            <SheetDirection direction={conv.state.result.preview.direction}>
              <table border={1}>
                <tbody>
                  {conv.state.result.preview.rows.slice(0, 12).map((row, r) => (
                    <tr key={r}>
                      {row.cells.map((c, k) => (
                        <td key={k}>
                          <Cell value={c.text ?? c.v} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </SheetDirection>
          </div>
        )}
      </section>
    </main>
  );
}

function RulesSummary({ rules }: { rules: LearnResult }) {
  const computed = new Map(rules.transform.computed.map((c) => [c.id, c]));
  const inputs = new Map(rules.input.columns.map((c) => [c.id, c]));
  return (
    <>
      <h3>Rules</h3>
      <p>
        output: {rules.output.file?.type ?? 'xlsx'}, direction {rules.output.direction}, language {rules.output.language}; input columns {rules.input.columns.length}; computed{' '}
        {rules.transform.computed.length}; value maps {rules.transform.valueMaps.length}
      </p>
      <SheetDirection direction={rules.output.direction}>
        <table border={1} data-testid="rules-columns">
          <thead>
            <tr>
              <th>output column</th>
              <th>from</th>
              <th>formula / source</th>
              <th>format</th>
            </tr>
          </thead>
          <tbody>
            {rules.output.columns.map((col, n) => {
              const comp = col.from ? computed.get(col.from) : undefined;
              const inp = col.from ? inputs.get(col.from) : undefined;
              return (
                <tr key={n}>
                  <td>
                    <Cell value={col.header} />
                  </td>
                  <td>
                    <Cell value={col.from ?? '(none)'} />
                  </td>
                  <td dir="ltr">{comp ? printFormula(comp.expr) : inp ? <>input: <Cell value={inp.header} /></> : ''}</td>
                  <td>{col.format ?? ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </SheetDirection>
      <details>
        <summary>Full rules JSON</summary>
        <pre dir="ltr">{JSON.stringify(rules, null, 2)}</pre>
      </details>
    </>
  );
}
