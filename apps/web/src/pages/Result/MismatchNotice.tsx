// Where a column's rule doesn't reproduce the example, said plainly (SPEC 8.11 "Live check"): "N rows in your example don't match this
// rule (rows 12, 57, ...)", or, for a column that mostly fails, "The rule for X doesn't reproduce your example yet". Shown on the
// column's line in the map and above the preview, each with "Fix the rule".
import { useI18n } from '../../i18n';
import { Button } from '../../ui';
import type { ColumnMismatch } from './helpers';
import { Named } from './Named';

/** The sentence for a column that mostly matches: how many rows don't, and the first of them. */
export function useMismatchText(): (m: ColumnMismatch) => string {
  const { t, lang } = useI18n();
  return (m) => {
    const n = m.count.toLocaleString(lang === 'he' ? 'he-IL' : 'en-US');
    if (m.rows.length === 0) return t(m.count === 1 ? 'column.mismatch.one.plain' : 'column.mismatch.other.plain', { n });
    const list = m.rows.join(', ') + (m.more ? ', …' : '');
    return t(m.count === 1 ? 'column.mismatch.one' : 'column.mismatch.other', { n, list });
  };
}

/** The message alone. `named` puts the column's name first (where several columns are listed together). */
export function MismatchMessage({ mismatch, named }: { mismatch: ColumnMismatch; named?: boolean }) {
  const text = useMismatchText();
  if (mismatch.failing) return <Named id="rule.failing" name={mismatch.header} />;
  return (
    <>
      {named ? (
        <>
          <bdi className="sentence__name">{mismatch.header}</bdi>:{' '}
        </>
      ) : null}
      {text(mismatch)}
    </>
  );
}

/** "Fix the rule": opens that column's editor. */
export function FixRuleButton({ header, onFix, variant = 'link' }: { header: string; onFix(): void; variant?: 'link' | 'secondary' }) {
  const { t } = useI18n();
  return (
    <Button variant={variant} size={variant === 'secondary' ? 'sm' : 'md'} aria-label={t('rule.fix.label', { column: header })} onClick={onFix}>
      {t('rule.fix')}
    </Button>
  );
}
