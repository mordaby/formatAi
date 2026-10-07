// "Add a source" on a format (My formats' cards, the format's page): one entry point, part of "Formats with several sources" (the feature
// switch, app/Features.tsx). While it is off there is nothing here at all.
import { useFeatures } from '../../app/Features';
import { LinkButton } from '../../app/LinkButton';
import { useI18n } from '../../i18n';

export interface AddSourceEntryProps {
  formatId: string;
  /** The card's small button, or the page's main one. */
  size?: 'sm';
  variant: 'primary' | 'secondary';
}

export function AddSourceEntry({ formatId, size, variant }: AddSourceEntryProps) {
  const { t } = useI18n();
  const { formatSources } = useFeatures();
  if (!formatSources) return null;
  return (
    <LinkButton variant={variant} {...(size ? { size } : {})} to={`/formats/${formatId}/add-source`}>
      {t('formats.addSource')}
    </LinkButton>
  );
}
