import { useNavigate } from 'react-router-dom';
import { useI18n } from '../i18n';
import { Button } from '../ui';

/**
 * SPEC 16.1 screen 5: for a signed-in user who has saved formats, Home's first action is "Run a format", with "Teach a new
 * format" next to it (the two drop zones open under it).
 */
export function HomeActions({ onTeach }: { onTeach(): void }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  return (
    <div className="view">
      <header className="tool__head">
        <h1>{t('home.convert')}</h1>
        <p className="lead">{t('home.convertLead')}</p>
      </header>
      <div className="home-actions">
        <Button variant="primary" iconEnd="arrow" onClick={() => navigate('/convert')}>
          {t('home.convert')}
        </Button>
        <Button variant="secondary" onClick={onTeach}>
          {t('home.teachNew')}
        </Button>
      </div>
    </div>
  );
}
