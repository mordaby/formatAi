import { useId, type ReactNode } from 'react';
import { useI18n } from '../i18n';
import { Button } from './Button';

export interface SheetProps {
  title: string;
  onClose(): void;
  children: ReactNode;
  className?: string;
}

/**
 * A docked side panel (the Result screen's editor sits on the inline-end side). On wide screens it
 * is just a column in the page flow; on narrow screens the same element becomes a full-width sheet
 * from the bottom edge with a backdrop (the CSS decides, at 860px). Render it only while open.
 */
export function Sheet({ title, onClose, children, className }: SheetProps) {
  const { t } = useI18n();
  const titleId = useId();
  return (
    <>
      <div className="sheet-backdrop" onClick={onClose} aria-hidden="true" />
      <aside
        className={['sheet', className ?? ''].filter(Boolean).join(' ')}
        aria-labelledby={titleId}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <header className="sheet__head">
          <h2 id={titleId}>{title}</h2>
          <Button variant="ghost" size="sm" icon="close" onClick={onClose} aria-label={t('common.close')} />
        </header>
        {children}
      </aside>
    </>
  );
}
