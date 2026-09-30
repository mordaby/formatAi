import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { Button } from './Button';

export interface CodeBlockProps {
  /** A value to show as indented JSON. */
  json?: unknown;
  /** Or ready-made text. */
  code?: string;
  /** Names the block (also its accessible name). */
  label: string;
}

/** Code and JSON are always left-to-right, whatever the page direction. Scrollable by keyboard; one-click copy. */
export function CodeBlock({ json, code, label }: CodeBlockProps) {
  const { t } = useI18n();
  const text = json !== undefined ? JSON.stringify(json, null, 2) : (code ?? '');
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard not available (an insecure context, a denied permission): the text is still selectable.
    }
  }

  return (
    <div className="code">
      <div className="code__bar">
        <span>{label}</span>
        <Button variant="ghost" size="sm" icon={copied ? 'check' : 'copy'} onClick={() => void copy()}>
          {copied ? t('common.copied') : t('common.copy')}
        </Button>
      </div>
      <pre className="code__pre" dir="ltr" tabIndex={0} role="region" aria-label={label}>
        <code>{text}</code>
      </pre>
    </div>
  );
}
