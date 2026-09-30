import { otherLang, useI18n } from '../i18n';
import { Button } from '../ui/Button';

/** SPEC 16.2: the header language toggle. Shows the language it would switch TO, in that language. */
export function LanguageToggle() {
  const { lang, toggle, t } = useI18n();
  const target = otherLang(lang);
  return (
    <Button variant="ghost" size="sm" onClick={toggle} lang={target} aria-label={t(`lang.switchTo.${target}`)}>
      {t(`lang.name.${target}`)}
    </Button>
  );
}
