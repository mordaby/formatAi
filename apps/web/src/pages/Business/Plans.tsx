import { useI18n } from '../../i18n';
import { PLAN_HEADS, planRows } from './planRows';

/**
 * The plans (SPEC 11): a real table where there is room, one block per plan on a phone (the same rows, read plan by plan). Both come from
 * the same data; CSS shows one of them (`display: none` also takes the other out of the reading order).
 */
export function Plans() {
  const { t, lang } = useI18n();
  const rows = planRows(t, lang);
  return (
    <>
      <div className="plans__wide">
        <table className="plans">
          <caption className="visually-hidden">{t('business.plans.caption')}</caption>
          <thead>
            <tr>
              <th scope="col">
                <span className="visually-hidden">{t('business.plans.feature')}</span>
              </th>
              {PLAN_HEADS.map((head) => (
                <th scope="col" key={head.tier}>
                  <span className="plans__name">{t(head.name)}</span>
                  <span className="plans__for">{t(head.for)}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label}>
                <th scope="row">{t(row.label)}</th>
                {row.cells.map((cell, i) => (
                  <td key={PLAN_HEADS[i]!.tier} className="tabular">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="plans__narrow">
        {PLAN_HEADS.map((head, i) => (
          <section className="plan" key={head.tier} aria-labelledby={`plan-${head.tier}`}>
            <h3 className="plans__name" id={`plan-${head.tier}`}>
              {t(head.name)}
            </h3>
            <p className="plans__for">{t(head.for)}</p>
            <dl className="plan__list">
              {rows.map((row) => (
                <div className="plan__row" key={row.label}>
                  <dt>{t(row.label)}</dt>
                  <dd className="tabular">{row.cells[i]}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </>
  );
}
