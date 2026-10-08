// Pieces the admin tabs share: a titled block, the loading and failed states, and a scrolling table wrapper.
import { useId, type ReactNode } from 'react';
import { useI18n } from '../../i18n';
import { Button, InlineMessage, Spinner } from '../../ui';

export function Block({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  const id = useId();
  return (
    <section className={['admin-block', className ?? ''].filter(Boolean).join(' ')} aria-labelledby={id}>
      <h2 id={id} className="admin-block__title">
        {title}
      </h2>
      {children}
    </section>
  );
}

export interface Row {
  label: string;
  value: ReactNode;
  /** A part of the row above it. */
  sub?: boolean;
}

/** Label and number pairs, as the overview shows them. */
export function Rows({ rows }: { rows: readonly Row[] }) {
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

export function Loading() {
  const { t } = useI18n();
  return (
    <p className="muted" role="status">
      <Spinner size={14} /> {t('admin.loading')}
    </p>
  );
}

export function LoadFailed({ onRetry }: { onRetry(): void }) {
  const { t } = useI18n();
  return (
    <InlineMessage
      tone="error"
      actions={
        <Button variant="secondary" size="sm" onClick={onRetry}>
          {t('error.tryAgain')}
        </Button>
      }
    >
      {t('admin.loadFailed')}
    </InlineMessage>
  );
}

/** A table that scrolls sideways on a narrow screen instead of squeezing its columns. */
export function Scroll({ children }: { children: ReactNode }) {
  return <div className="admin-scroll">{children}</div>;
}
