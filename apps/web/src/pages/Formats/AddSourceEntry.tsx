// "Add a source" on a format (My formats' cards, the format's page) - and the plan's sources per format (SPEC 11), said BEFORE the user starts:
// a format that already has as many sources as the plan allows shows "X already has N sources (your plan's limit)." with the upgrade, instead
// of a way in that would fail at Save (the server's own count, `canAddSource`). One entry point, part of "Formats with several sources"
// (the feature switch, app/Features.tsx): while it is off there is nothing here at all.
import { canAddSource } from '@formatai/shared';
import { useFeatures } from '../../app/Features';
import { LinkButton } from '../../app/LinkButton';
import { useMe } from '../../app/Me';
import { UpgradeButton } from '../../app/Upgrade';
import { useI18n } from '../../i18n';
import { Marked } from '../Result/Named';

export interface AddSourceEntryProps {
  formatId: string;
  formatName: string;
  /** How many sources (conversions) the format has now. */
  sources: number;
  /** The card's small button, or the page's main one. */
  size?: 'sm';
  variant: 'primary' | 'secondary';
}

export function AddSourceEntry({ formatId, formatName, sources, size, variant }: AddSourceEntryProps) {
  const { formatSources } = useFeatures();
  // (the signed-in user's plan: a session that ended on the page keeps it as it was - SPEC 5 E - and the way in asks to sign in)
  const tier = useMe().user?.tier;
  if (!formatSources) return null;
  if (tier && !canAddSource(tier, sources)) return <SourceLimit formatName={formatName} sources={sources} />;
  return <AddSourceLink formatId={formatId} {...(size ? { size } : {})} variant={variant} />;
}

function AddSourceLink({ formatId, size, variant }: Pick<AddSourceEntryProps, 'formatId' | 'size' | 'variant'>) {
  const { t } = useI18n();
  return (
    <LinkButton variant={variant} {...(size ? { size } : {})} to={`/formats/${formatId}/add-source`}>
      {t('formats.addSource')}
    </LinkButton>
  );
}

/** "X already has N sources (your plan's limit)." and the upgrade (also the Add a source screen's, for a format at its limit). */
export function SourceLimit({ formatName, sources }: { formatName: string; sources: number }) {
  const { lang } = useI18n();
  return (
    <div className="source-limit" data-testid="source-limit">
      <p className="muted">
        <Marked
          id="formats.sourceLimit"
          nodes={{
            format: (
              <strong>
                <bdi>{formatName}</bdi>
              </strong>
            ),
            n: <span className="tabular">{sources.toLocaleString(lang === 'he' ? 'he-IL' : 'en-US')}</span>,
          }}
        />
      </p>
      <UpgradeButton variant="link" trigger="sourcesPerFormat" />
    </div>
  );
}
