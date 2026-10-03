// "New column in this file" (SPEC 8.15): the file has columns the source does not know and no format uses. One quiet notice after the
// run - nothing is added to an output for the user. They can dismiss it (remembered per source, so it does not come back every month) or
// open the editor of one of the source's formats to add the column there (a small choice when there are several).
import { useState } from 'react';
import { Cell } from '../../components/Cell';
import { useI18n } from '../../i18n';
import { Button, InlineMessage } from '../../ui';
import { quoteNames } from './logic';
import type { NewColumnsNotice } from './useConvertFlow';

export interface NewColumnsProps {
  notice: NewColumnsNotice;
  onDismiss(): void;
  /** Opens the editor of this format (the page holds the file for the trip). */
  onAdd(format: { conversionId: string; formatId: string }): void;
}

export function NewColumns({ notice, onDismiss, onAdd }: NewColumnsProps) {
  const { t } = useI18n();
  const [choosing, setChoosing] = useState(false);
  const many = notice.columns.length > 1;
  const { formats } = notice;

  return (
    <div data-testid="new-columns">
      <InlineMessage
        tone="info"
        actions={
          <>
            {choosing ? (
              <>
                <span className="muted">{t('conv.newColumns.pick')}</span>
                {formats.map((f) => (
                  <Button key={f.conversionId} variant="secondary" size="sm" onClick={() => onAdd(f)}>
                    <Cell value={f.formatName} />
                  </Button>
                ))}
              </>
            ) : formats.length > 0 ? (
              <Button variant="secondary" size="sm" onClick={() => (formats.length === 1 ? onAdd(formats[0]!) : setChoosing(true))}>
                {t(many ? 'conv.newColumns.add.other' : 'conv.newColumns.add')}
              </Button>
            ) : null}
            <Button variant="ghost" size="sm" onClick={onDismiss}>
              {t('conv.newColumns.dismiss')}
            </Button>
          </>
        }
      >
        <p data-testid="new-columns-text">{t(many ? 'conv.newColumns.other' : 'conv.newColumns.one', { columns: quoteNames(notice.columns) })}</p>
        <p className="muted">{t('conv.newColumns.hint')}</p>
      </InlineMessage>
    </div>
  );
}
