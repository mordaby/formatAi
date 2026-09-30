import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

/**
 * block: these files can't be used, and here is why (amber bar)
 * warn: needs your go-ahead (amber)
 * error: something really failed: a file that can't be read, the server (the only red)
 * info: a nudge (teal), e.g. "sign in to keep going"
 */
export type InlineMessageTone = 'block' | 'warn' | 'error' | 'info';

const ICONS: Record<InlineMessageTone, IconName> = { block: 'alert', warn: 'alert', error: 'alert', info: 'info' };

export interface InlineMessageProps {
  tone: InlineMessageTone;
  /** Short heading, optional. */
  title?: ReactNode;
  /** The exact reason: what is wrong. */
  children: ReactNode;
  /** What to do about it. */
  todo?: ReactNode;
  /** Buttons for the next step. */
  actions?: ReactNode;
  className?: string;
}

export function InlineMessage({ tone, title, children, todo, actions, className }: InlineMessageProps) {
  return (
    <div className={['msg', `msg--${tone}`, className ?? ''].filter(Boolean).join(' ')} role={tone === 'block' || tone === 'error' ? 'alert' : 'status'}>
      <Icon name={ICONS[tone]} className="msg__icon" />
      <div className="msg__body">
        {title ? <p className="msg__title">{title}</p> : null}
        <div className="msg__text">{children}</div>
        {todo ? <p className="msg__todo">{todo}</p> : null}
        {actions ? <div className="msg__actions">{actions}</div> : null}
      </div>
    </div>
  );
}
