// The overview's "How the product is used" section (SPEC 14.2; the beta usage events, 14.1): learns by path and how they ended, matching, which
// formats people pick, the limits they hit, saves, coming back, and the signed-in funnel. Plain tables, no chart library.
//
// A group the server could not compute (its event type has no row in the period) is `null`, and shown as "n/a" - never as 0: the page cannot
// tell "no one did it" from "nothing was recorded".
import { limits, type AdminLearnRow, type AdminUsage } from '@formatai/shared';
import type { ReactNode } from 'react';
import { useI18n, type MessageKey } from '../../i18n';
import { numberText } from './format';
import { Block, Rows, Scroll } from './parts';

const PATHS = ['local', 'llm', 'cache'] as const;
const STATUSES = ['verified', 'failed', 'partial', 'blocked', 'notReady', 'error'] as const;

/** The count of one (path, status) of the learns table: 0 when that combination did not happen (the event type has rows, so the 0 is known). */
function countOf(rows: readonly AdminLearnRow[], path: string, status: string): number {
  return rows.find((r) => r.path === path && r.status === status)?.count ?? 0;
}

export function Usage({ usage }: { usage: AdminUsage }) {
  const { t, lang } = useI18n();
  const num = (v: number): string => numberText(lang, v);
  const na = t('admin.na');
  const orNa = (v: number | null): string => (v === null ? na : num(v));
  const percent = (share: number): string => `${Math.round(share * 100)}%`;
  /** A group that is not known, or its rows. */
  const group = (known: unknown, rows: () => ReactNode): ReactNode => (known === null ? <p className="muted">{na}</p> : rows());
  const days = limits.admin.returningAfterDays;
  const learns = usage.learns;

  return (
    <Block title={t('admin.ov.usage')} className="admin-usage">
      <p className="muted admin-note">{t('admin.us.note')}</p>

      <div className="admin-grid">
        <div className="admin-block admin-usage__wide">
          <h3 className="admin-block__sub">{t('admin.us.learns')}</h3>
          {group(learns, () => (
            <Scroll>
              <table className="admin-table" data-testid="usage-learns">
                <thead>
                  <tr>
                    <th scope="col">{t('admin.us.learns.path')}</th>
                    {STATUSES.map((s) => (
                      <th key={s} scope="col" className="num">
                        {t(`admin.us.status.${s}` as MessageKey)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {PATHS.map((path) => (
                    <tr key={path}>
                      <th scope="row">{t(`admin.us.path.${path}` as MessageKey)}</th>
                      {STATUSES.map((status) => (
                        <td key={status} className="num tabular">
                          {num(countOf(learns!, path, status))}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </Scroll>
          ))}
          <p className="muted admin-note">{t('admin.us.learns.note')}</p>
        </div>

        <div className="admin-block">
          <h3 className="admin-block__sub">{t('admin.us.matching')}</h3>
          {group(usage.matching, () => (
            <Rows
              rows={[
                { label: t('admin.us.matching.auto'), value: num(usage.matching!.auto) },
                { label: t('admin.us.matching.choose'), value: num(usage.matching!.choose) },
                { label: t('admin.us.matching.none'), value: num(usage.matching!.none) },
              ]}
            />
          ))}
        </div>

        <div className="admin-block">
          <h3 className="admin-block__sub">{t('admin.us.chosen')}</h3>
          {group(usage.formatsChosen, () => (
            <Rows
              rows={[
                { label: t('admin.us.chosen.asked'), value: num(usage.formatsChosen!.asked) },
                { label: t('admin.us.chosen.single'), value: num(usage.formatsChosen!.single), sub: true },
                { label: t('admin.us.chosen.batch'), value: num(usage.formatsChosen!.batch), sub: true },
                { label: t('admin.us.chosen.all'), value: percent(usage.formatsChosen!.allShare) },
                { label: t('admin.us.chosen.offered'), value: num(usage.formatsChosen!.avgOffered) },
                { label: t('admin.us.chosen.chosen'), value: num(usage.formatsChosen!.avgChosen) },
              ]}
            />
          ))}
          <p className="muted admin-note">{t('admin.us.chosen.note')}</p>
        </div>

        <div className="admin-block">
          <h3 className="admin-block__sub">{t('admin.us.limits')}</h3>
          {group(usage.limits, () => (
            <Rows
              rows={usage.limits!.map((l) => ({
                label: l.limit,
                value: num(l.count),
              }))}
            />
          ))}
        </div>

        <div className="admin-block">
          <h3 className="admin-block__sub">{t('admin.us.saves')}</h3>
          {group(usage.saves, () => (
            <Rows
              rows={[
                { label: t('admin.us.saves.new'), value: num(usage.saves!.new) },
                { label: t('admin.us.saves.anotherInput'), value: num(usage.saves!.anotherInput) },
                { label: t('admin.us.saves.update'), value: num(usage.saves!.update) },
                { label: t('admin.us.saves.edit'), value: num(usage.saves!.edit) },
              ]}
            />
          ))}
          <p className="muted admin-note">{t('admin.us.saves.note')}</p>
        </div>

        <div className="admin-block">
          <h3 className="admin-block__sub">{t('admin.us.returning')}</h3>
          {group(usage.returning, () => (
            <Rows
              rows={[
                { label: t('admin.us.returning.users', { n: days }), value: num(usage.returning!.users) },
                { label: t('admin.us.returning.active'), value: num(usage.returning!.activeUsers) },
                { label: t('admin.us.returning.runs'), value: num(usage.returning!.runs) },
                { label: t('admin.us.returning.perUser'), value: usage.returning!.runsPerActiveUser === null ? na : num(usage.returning!.runsPerActiveUser) },
              ]}
            />
          ))}
        </div>

        <div className="admin-block">
          <h3 className="admin-block__sub">{t('admin.us.funnel')}</h3>
          <Rows
            rows={[
              { label: t('admin.us.funnel.uploaded'), value: orNa(usage.funnel.uploaded) },
              { label: t('admin.us.funnel.learned'), value: orNa(usage.funnel.learned) },
              { label: t('admin.us.funnel.saved'), value: orNa(usage.funnel.saved) },
              { label: t('admin.us.funnel.ran'), value: orNa(usage.funnel.ran) },
              { label: t('admin.us.funnel.ranAgain', { n: days }), value: orNa(usage.funnel.ranAgain) },
            ]}
          />
          <p className="muted admin-note">{t('admin.us.funnel.note')}</p>
        </div>
      </div>
    </Block>
  );
}
