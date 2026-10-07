import type { WaitlistTrigger } from '@formatai/shared';
import { useId, useState } from 'react';
import { webConfig } from '../config';
import { useI18n, type MessageKey } from '../i18n';
import { Button, Panel } from '../ui';
import { WaitlistForm } from './WaitlistForm';

export interface UpgradeButtonProps {
  variant?: 'primary' | 'secondary' | 'link';
  /** Which limit (or hint) put the button there: recorded with the waitlist entry so the owner sees what people ran into (SPEC 11 `upgrade_intent`). */
  trigger?: WaitlistTrigger;
  /** The button's words (default: "Upgrade"). */
  label?: MessageKey;
}

/**
 * The "Upgrade" button (SPEC 11). There is no payment code in the MVP and paid plans are set up by the team, so it opens a short panel with
 * the paid-waitlist form (v13 M4: an email, filled in for a signed-in user, and an optional message). The mail link stays under it
 * for whoever would rather write.
 */
export function UpgradeButton({ variant = 'secondary', trigger = 'other', label = 'aiLimit.upgrade' }: UpgradeButtonProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span className="upgrade">
      <Button variant={variant} aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen((o) => !o)}>
        {t(label)}
      </Button>
      {open && (
        <Panel id={id} title={t('upgrade.title')} onClose={() => setOpen(false)}>
          <UpgradeBody trigger={trigger} />
        </Panel>
      )}
    </span>
  );
}

/** What the upgrade offers (the panel above, and the out-of-AI-formats dialog): a line on paid plans, the waitlist form, the mail link. */
export function UpgradeBody({ trigger }: { trigger: WaitlistTrigger }) {
  const { t } = useI18n();
  return (
    <>
      <p>{t('upgrade.text')}</p>
      <WaitlistForm trigger={trigger} />
      <p className="muted">
        {t('waitlist.contact')}: <a href={webConfig.contactHref}>{t('upgrade.contact')}</a>
      </p>
    </>
  );
}
