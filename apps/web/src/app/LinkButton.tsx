import type { ReactNode } from 'react';
import { Link, type LinkProps } from 'react-router-dom';
import { Icon, type ButtonVariant, type IconName } from '../ui';

export interface LinkButtonProps extends Omit<LinkProps, 'className'> {
  variant?: ButtonVariant;
  size?: 'md' | 'sm';
  iconEnd?: IconName;
  children: ReactNode;
}

/** A link that looks like a button (navigation is a link, not a click handler: it can be opened in a new tab). */
export function LinkButton({ variant = 'secondary', size = 'md', iconEnd, children, ...rest }: LinkButtonProps) {
  const cls = ['btn', `btn--${variant}`, size === 'sm' ? 'btn--sm' : ''].filter(Boolean).join(' ');
  return (
    <Link className={cls} {...rest}>
      {children}
      {iconEnd ? <Icon name={iconEnd} size={size === 'sm' ? 16 : 18} /> : null}
    </Link>
  );
}
