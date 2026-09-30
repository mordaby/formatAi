import type { ReactNode } from 'react';
import { Icon } from './Icon';

export type BadgeTone = 'verified' | 'check' | 'neutral';

export interface BadgeProps {
  /** verified = teal check ("matches"); check = amber ("please check"); neutral = plain. */
  tone?: BadgeTone;
  children: ReactNode;
}

export function Badge({ tone = 'neutral', children }: BadgeProps) {
  return (
    <span className={`badge badge--${tone}`}>
      {tone === 'verified' && <Icon name="check" size={14} />}
      {tone === 'check' && <Icon name="alert" size={14} />}
      {children}
    </span>
  );
}
