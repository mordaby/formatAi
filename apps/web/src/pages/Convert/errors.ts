import { flowErrorText } from '../../flow/errors';
import type { I18n } from '../../i18n';
import type { ConvertError } from './useConvertFlow';

/** What went wrong, in the UI language: what happened and what to do. */
export function convertErrorText(i18n: I18n, error: ConvertError): string {
  switch (error.kind) {
    case 'unreadable':
      return i18n.t('conv.error.unreadable');
    case 'noTable':
      return i18n.t('conv.error.noTable');
    case 'sheetNotFound':
      return i18n.t('conv.error.sheetNotFound');
    case 'invalidRules':
      return i18n.t('conv.error.invalidRules');
    case 'gone':
      return i18n.t('conv.error.gone');
    default:
      return flowErrorText(i18n, error);
  }
}
