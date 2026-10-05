// The admin overview (SPEC 14.2): users by plan and new sign-ups, learns (the AI step, the cache, the computer), saved formats, AI calls and
// their estimated cost (per day, per model), the problems the checks found most, function requests, events. For the last 7 / 30 / 90 UTC days.
// Simple tables and one small chart. A number the server cannot know is "n/a".
import { limits, type AdminOverview, type AdminPeriodDays } from '@formatai/shared';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useLoad } from '../../app/useLoad';
import { useI18n } from '../../i18n';
import { useServices } from '../../services';
import { CostChart } from './CostChart';
import { numberText, usdText } from './format';
import { Block, LoadFailed, Loading, Scroll } from './parts';

const PERIODS = limits.admin.periodsDays as readonly AdminPeriodDays[];

interface Row {
  label: string;
  value: ReactNode;
  /** A part of the row above it. */
  sub?: boolean;
}

function Rows({ rows }: { rows: readonly Row[] }) {
  return (
    <table className="admin-table admin-table--rows">
      <tbody>
        {rows.map((r) => (
          <tr key={r.label} className={r.sub ? 'admin-table__sub' : undefined}>
            <th scope="row">{r.label}</th>
            <td className="num tabular">{r.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function Overview() {
  const { t } = useI18n();
  const { api } = useServices();
  const [days, setDays] = useState<AdminPeriodDays>(limits.admin.defaultPeriodDays as AdminPeriodDays);
  const load = useLoad((signal) => api.admin.overview(days, signal), [days]);

  return (
    <div className="admin-panel">
      <div className="admin-panel__bar">
        <div role="group" aria-label={t('admin.period.label')} className="admin-seg">
          {PERIODS.map((p) => (
            <button key={p} type="button" className="admin-seg__item" aria-pressed={p === days} onClick={() => setDays(p)}>
              {t('admin.period.days', { n: p })}
            </button>
          ))}
        </div>
        {load.state.status === 'ready' ? (
          <p className="muted tabular">
            {/* (the dates are isolated left-to-right runs, so a Hebrew sentence around them does not reorder them) */}
            {t('admin.range', { from: `⁦${load.state.data.from}⁩`, to: `⁦${load.state.data.to}⁩` })}
          </p>
        ) : null}
      </div>

      {load.state.status === 'loading' && <Loading />}
      {load.state.status === 'error' && <LoadFailed onRetry={load.reload} />}
      {load.state.status === 'ready' && <Numbers o={load.state.data} />}
    </div>
  );
}

function Numbers({ o }: { o: AdminOverview }) {
  const { t, lang } = useI18n();
  const num = (v: number): string => numberText(lang, v);
  const money = (v: number | null): string => (v === null ? t('admin.na') : usdText(v));
  const highest = Math.max(0, ...o.llm.byDay.map((d) => d.costUsd ?? 0));
  return (
    <>
      <div className="admin-grid">
        <Block title={t('admin.ov.users')}>
          <Rows
            rows={[
              { label: t('admin.ov.users.total'), value: num(o.users.total) },
              { label: t('admin.ov.users.registered'), value: num(o.users.registered), sub: true },
              { label: t('admin.ov.users.paid'), value: num(o.users.paid), sub: true },
              { label: t('admin.ov.users.new'), value: num(o.users.newInPeriod) },
              { label: t('admin.ov.users.active'), value: num(o.users.activeInPeriod) },
            ]}
          />
        </Block>

        <Block title={t('admin.ov.learns')}>
          <Rows
            rows={[
              { label: t('admin.ov.learns.ai'), value: num(o.learns.ai) },
              { label: t('admin.ov.learns.aiVerified'), value: num(o.learns.aiVerified), sub: true },
              { label: t('admin.ov.learns.aiFailed'), value: num(o.learns.aiFailed), sub: true },
              { label: t('admin.ov.learns.aiErrored'), value: num(o.learns.aiErrored), sub: true },
              { label: t('admin.ov.learns.cache'), value: num(o.learns.cache) },
              { label: t('admin.ov.learns.local'), value: o.learns.local === null ? t('admin.na') : num(o.learns.local) },
            ]}
          />
          <p className="muted admin-note">{o.learns.local === null ? `${t('admin.ov.learns.localNote')} ` : ''}{t('admin.ov.learns.verifiedNote')}</p>
        </Block>

        <Block title={t('admin.ov.registry')}>
          <Rows
            rows={[
              { label: t('admin.ov.registry.formats'), value: num(o.conversions.formats) },
              { label: t('admin.ov.registry.formatsNew'), value: num(o.conversions.formatsNew), sub: true },
              { label: t('admin.ov.registry.ran'), value: num(o.conversions.ranInPeriod) },
              { label: t('admin.ov.registry.runs'), value: num(o.conversions.runsAllTime) },
            ]}
          />
        </Block>

        <Block title={t('admin.ov.fr')}>
          <Rows
            rows={[
              { label: t('admin.ov.fr.groups'), value: num(o.functionRequests.groups) },
              { label: t('admin.ov.fr.requests'), value: num(o.functionRequests.requests) },
              { label: t('admin.ov.fr.atThreshold', { n: limits.learn.functionRequests.issueThreshold }), value: num(o.functionRequests.atThreshold) },
              { label: t('admin.ov.fr.issueOpened'), value: num(o.functionRequests.issueOpened) },
              { label: t('admin.ov.fr.new'), value: num(o.functionRequests.newInPeriod) },
            ]}
          />
          <p className="admin-note">
            <Link to="/admin?tab=requests">{t('admin.ov.fr.see')}</Link>
          </p>
        </Block>
      </div>

      <Block title={t('admin.ov.ai')}>
        <Rows
          rows={[
            { label: t('admin.ov.ai.calls'), value: num(o.llm.calls) },
            { label: t('admin.ov.ai.cost'), value: <span dir="ltr">{money(o.llm.costUsd)}</span> },
          ]}
        />
        <p className="muted admin-note">
          {o.llm.unpriced > 0 ? `${t('admin.ov.ai.unpriced', { n: o.llm.unpriced })} ` : ''}
          {t('admin.ov.ai.note')}
        </p>
        {highest > 0 ? (
          <CostChart
            rows={o.llm.byDay}
            label={t('admin.chart.label', { from: o.from, to: o.to, max: usdText(highest) })}
            maxText={usdText(highest)}
            tip={(row) => t('admin.chart.day', { day: row.day, calls: row.aiCalls, cost: money(row.costUsd) })}
          />
        ) : (
          <p className="muted">{t('admin.chart.none')}</p>
        )}

        <h3 className="admin-block__sub">{t('admin.byModel')}</h3>
        {o.llm.byModel.length === 0 ? (
          <p className="muted">{t('admin.ov.problems.empty')}</p>
        ) : (
          <Scroll>
            <table className="admin-table">
              <thead>
                <tr>
                  <th scope="col">{t('admin.col.model')}</th>
                  <th scope="col" className="num">
                    {t('admin.col.calls')}
                  </th>
                  <th scope="col" className="num">
                    {t('admin.col.inputTokens')}
                  </th>
                  <th scope="col" className="num">
                    {t('admin.col.outputTokens')}
                  </th>
                  <th scope="col" className="num">
                    {t('admin.col.cost')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {o.llm.byModel.map((m) => (
                  <tr key={m.model}>
                    <th scope="row" dir="ltr" className="admin-code">
                      {m.model}
                    </th>
                    <td className="num tabular">{num(m.calls)}</td>
                    <td className="num tabular">{num(m.inputTokens)}</td>
                    <td className="num tabular">{num(m.outputTokens)}</td>
                    <td className="num tabular" dir="ltr">
                      {money(m.costUsd)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Scroll>
        )}

        <details className="admin-details">
          <summary>{t('admin.byDay')}</summary>
          <Scroll>
            <table className="admin-table">
              <thead>
                <tr>
                  <th scope="col">{t('admin.col.day')}</th>
                  <th scope="col" className="num">
                    {t('admin.col.calls')}
                  </th>
                  <th scope="col" className="num">
                    {t('admin.col.cost')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {[...o.llm.byDay].reverse().map((d) => (
                  <tr key={d.day}>
                    <th scope="row" dir="ltr">
                      {d.day}
                    </th>
                    <td className="num tabular">{num(d.aiCalls)}</td>
                    <td className="num tabular" dir="ltr">
                      {money(d.costUsd)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Scroll>
        </details>
      </Block>

      <div className="admin-grid">
        <Block title={t('admin.ov.problems')}>
          {o.problems.length === 0 ? (
            <p className="muted">{t('admin.ov.problems.empty')}</p>
          ) : (
            <table className="admin-table">
              <thead>
                <tr>
                  <th scope="col">{t('admin.col.kind')}</th>
                  <th scope="col" className="num">
                    {t('admin.col.times')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {o.problems.map((p) => (
                  <tr key={p.kind}>
                    <th scope="row" dir="ltr" className="admin-code">
                      {p.kind}
                    </th>
                    <td className="num tabular">{num(p.count)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Block>

        <Block title={t('admin.ov.events')}>
          {o.events.length === 0 ? (
            <p className="muted">{t('admin.ov.events.empty')}</p>
          ) : (
            <Rows rows={o.events.map((e) => ({ label: e.type, value: num(e.count) }))} />
          )}
        </Block>
      </div>
    </>
  );
}
