import { useId, useState } from 'react';
import { limits } from '@formatai/shared';
import { useI18n } from '../i18n';
import { Button, Icon, Panel, Switch } from '../ui';

export interface HomeMaskingProps {
  masking: boolean;
  onChange(masking: boolean): void;
  disabled?: boolean;
}

/**
 * The masking switch (SPEC 7.2): on by default, its one-line explanation in the current state, and
 * a "What's the difference?" link that opens the copy for on, off and always.
 */
/** The most rows one learn sends (the learning loop's cap): what masking off sends as they are. */
const offParams = { rows: limits.learn.loop.maxRowsTotal };

export function HomeMasking({ masking, onChange, disabled }: HomeMaskingProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const explainerId = useId();
  const panelId = useId();
  return (
    <div className="masking">
      <Switch label={t('masking.label')} checked={masking} onChange={onChange} describedBy={explainerId} {...(disabled ? { disabled } : {})} />
      <p className="masking__text" id={explainerId}>
        {masking ? t('masking.on') : t('masking.off', offParams)}{' '}
        <Button variant="link" aria-expanded={open} aria-controls={open ? panelId : undefined} onClick={() => setOpen((o) => !o)}>
          {t('masking.difference')}
        </Button>
      </p>
      {open && (
        <Panel id={panelId} title={t('masking.panelTitle')} onClose={() => setOpen(false)}>
          <dl className="copy-table">
            <div>
              <dt>{t('masking.state.on')}</dt>
              <dd>{t('masking.on')}</dd>
            </div>
            <div>
              <dt>{t('masking.state.off')}</dt>
              <dd>{t('masking.off', offParams)}</dd>
            </div>
            <div>
              <dt>{t('masking.state.always')}</dt>
              <dd className="copy-table__always">
                <Icon name="lock" size={16} />
                {t('masking.always')}
              </dd>
            </div>
          </dl>
        </Panel>
      )}
    </div>
  );
}
