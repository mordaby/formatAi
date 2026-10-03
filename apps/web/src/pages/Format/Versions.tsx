// The versions of a saved source (SPEC 8.11 "Saving"): every save keeps the one before it, and an old version can be restored
// (it is saved as a new version, so nothing is lost).
import { useState } from 'react';
import { isApiError } from '../../api';
import { useLoad } from '../../app/useLoad';
import { useI18n } from '../../i18n';
import { useServices } from '../../services';
import { Badge, Button, InlineMessage, Spinner } from '../../ui';
import { shortDate, statusLabel, statusTone } from '../Formats/statusText';

export interface VersionsProps {
  conversionId: string;
  /** Changes whenever a version was saved here, so the list is read again. */
  refreshKey: number;
  /** A version was restored (the rules on screen are now out of date: the caller loads them again). */
  onRestored(version: number): void;
}

export function Versions({ conversionId, refreshKey, onRestored }: VersionsProps) {
  const { t, lang } = useI18n();
  const { api } = useServices();
  const versions = useLoad((signal) => api.registry.versions(conversionId, signal), [conversionId, refreshKey]);
  const [restoring, setRestoring] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const restore = async (version: number): Promise<void> => {
    setRestoring(version);
    setProblem(null);
    try {
      const restored = await api.registry.restore(conversionId, version);
      onRestored(restored.version);
    } catch (e) {
      // An old version from before a change to the format no longer fits it (SPEC 8.12 format lock); anything else is a plain failure.
      setProblem(isApiError(e) && e.code === 'formatMismatch' ? t('versions.restoreMismatch') : t('versions.restoreFailed'));
    } finally {
      setRestoring(null);
    }
  };

  return (
    <section className="versions" aria-labelledby="versions-title" data-testid="versions">
      <h2 id="versions-title">{t('versions.title')}</h2>
      <p className="muted">{t('versions.lead')}</p>
      {versions.state.status === 'loading' && (
        <p className="muted">
          <Spinner size={14} /> {t('formats.loading')}
        </p>
      )}
      {versions.state.status === 'error' && <InlineMessage tone="error">{t('versions.loadFailed')}</InlineMessage>}
      {problem ? <InlineMessage tone="block">{problem}</InlineMessage> : null}
      {versions.state.status === 'ready' && (
        <>
          <ul className="version-list">
            {versions.state.data.map((v) => (
              <li key={v.version} className="version-list__item" data-version={v.version} data-current={v.current || undefined}>
                <span className="tabular version-list__n">{t('versions.version', { n: v.version })}</span>
                <span className="muted tabular">{shortDate(v.at, lang)}</span>
                <Badge tone={statusTone(v.status)}>{statusLabel(t, v.status, v.acceptedDifferences)}</Badge>
                {v.current ? (
                  <Badge>{t('versions.current')}</Badge>
                ) : (
                  <Button variant="secondary" size="sm" loading={restoring === v.version} disabled={restoring !== null} onClick={() => void restore(v.version)}>
                    {t('versions.restore')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
          {versions.state.data.length <= 1 && <p className="muted">{t('versions.none')}</p>}
        </>
      )}
    </section>
  );
}
