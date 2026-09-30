import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import { Spinner } from './Spinner';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'link';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** primary = the one main action of the screen (brand color); use at most one per screen. */
  variant?: ButtonVariant;
  size?: 'md' | 'sm';
  /** Shows a spinner and blocks clicks; the button keeps its size. */
  loading?: boolean;
  /** An icon before the label. */
  icon?: IconName;
  /** An icon after the label; directional icons (arrow, chevron) mirror in right-to-left. */
  iconEnd?: IconName;
  block?: boolean;
  children?: ReactNode;
}

export function Button({ variant = 'secondary', size = 'md', loading, icon, iconEnd, block, className, children, type = 'button', onClick, ...rest }: ButtonProps) {
  const cls = ['btn', `btn--${variant}`, size === 'sm' ? 'btn--sm' : '', block ? 'btn--block' : '', !children ? 'btn--icon' : '', className ?? '']
    .filter(Boolean)
    .join(' ');
  const iconSize = size === 'sm' ? 16 : 18;
  return (
    <button type={type} className={cls} aria-busy={loading || undefined} onClick={loading ? undefined : onClick} {...rest}>
      {loading ? <Spinner size={16} /> : icon ? <Icon name={icon} size={iconSize} /> : null}
      {children}
      {iconEnd ? <Icon name={iconEnd} size={iconSize} /> : null}
    </button>
  );
}
