import { useId, type ReactNode } from 'react';
import { useI18n } from '../i18n';
import { Button } from './Button';

export interface PanelProps {
  title: string;
  onClose(): void;
  children: ReactNode;
  /** Id for the element that opens it (aria-controls). */
  id?: string;
}

/** A short panel that opens in the flow of the page (not over it): "What's the difference?", "See what we send". */
export function Panel({ title, onClose, children, id }: PanelProps) {
  const { t } = useI18n();
  const titleId = useId();
  return (
    <section
      className="panel"
      id={id}
      aria-labelledby={titleId}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <header className="panel__head">
        <h3 className="panel__title" id={titleId}>
          {title}
        </h3>
        <Button variant="ghost" size="sm" icon="close" onClick={onClose} aria-label={t('common.close')} />
      </header>
      <div className="panel__body">{children}</div>
    </section>
  );
}
