import { useId, useState } from 'react';
import { webConfig } from '../config';
import { useI18n } from '../i18n';
import { Button, Panel } from '../ui';

/**
 * The "Upgrade" button (SPEC 11). There is no payment code in the MVP and paid plans are set up by the team, so it opens a
 * short panel that says so and points to a contact address (a placeholder until M4 records the intent with the limit that
 * triggered it).
 */
export function UpgradeButton({ variant = 'secondary' }: { variant?: 'primary' | 'secondary' }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span className="upgrade">
      <Button variant={variant} aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen((o) => !o)}>
        {t('aiLimit.upgrade')}
      </Button>
      {open && (
        <Panel id={id} title={t('upgrade.title')} onClose={() => setOpen(false)}>
          <p>{t('upgrade.text')}</p>
          <p>
            <a href={webConfig.contactHref}>{t('upgrade.contact')}</a>
          </p>
        </Panel>
      )}
    </span>
  );
}
