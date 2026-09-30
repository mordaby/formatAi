import type { ReactNode } from 'react';

export type IconName =
  | 'check'
  | 'alert'
  | 'info'
  | 'pencil'
  | 'arrow'
  | 'chevron'
  | 'chevronDown'
  | 'close'
  | 'file'
  | 'upload'
  | 'lock'
  | 'copy'
  | 'undo'
  | 'redo'
  | 'plus'
  | 'trash'
  | 'grip'
  | 'chevronUp';

// Line icons on a 20px grid, drawn with currentColor. Directional ones (arrow, chevron) point
// toward the inline end; they mirror in right-to-left (SPEC 16.2) unless told otherwise.
const PATHS: Record<IconName, ReactNode> = {
  check: <path d="M4.5 10.5l3.7 3.7L15.5 6.5" />,
  alert: (
    <>
      <path d="M10 3.2l7.3 12.6a.6.6 0 0 1-.5.9H3.2a.6.6 0 0 1-.5-.9L10 3.2z" />
      <path d="M10 8v3.6" />
      <path d="M10 14h.01" />
    </>
  ),
  info: (
    <>
      <circle cx="10" cy="10" r="7.2" />
      <path d="M10 9.2v4.2" />
      <path d="M10 6.6h.01" />
    </>
  ),
  pencil: <path d="M3.6 16.4l.7-3.4L13.2 4a1.5 1.5 0 0 1 2.1 0l.7.7a1.5 1.5 0 0 1 0 2.1L7.1 15.7l-3.5.7zM11.7 5.6l2.7 2.7" />,
  arrow: <path d="M3.8 10h12.4M11.4 5.2l4.8 4.8-4.8 4.8" />,
  chevron: <path d="M7.5 4.5l5.5 5.5-5.5 5.5" />,
  chevronDown: <path d="M4.5 7.5l5.5 5.5 5.5-5.5" />,
  close: <path d="M5 5l10 10M15 5L5 15" />,
  file: (
    <>
      <path d="M5.2 2.8h6L15.4 7v10.2H5.2V2.8z" />
      <path d="M11.2 2.8V7h4.2" />
    </>
  ),
  upload: <path d="M10 13V4.2M6.4 7.6L10 4l3.6 3.6M4 13.4v2.4h12v-2.4" />,
  lock: (
    <>
      <rect x="4.4" y="8.8" width="11.2" height="8" rx="1.6" />
      <path d="M7 8.8V6.6a3 3 0 0 1 6 0v2.2" />
    </>
  ),
  undo: <path d="M7.2 4.8L3.6 8.4l3.6 3.6M3.9 8.4h7.4a4.2 4.2 0 0 1 0 8.4H7.6" />,
  redo: <path d="M12.8 4.8l3.6 3.6-3.6 3.6M16.1 8.4H8.7a4.2 4.2 0 0 0 0 8.4h3.7" />,
  plus: <path d="M10 4.2v11.6M4.2 10h11.6" />,
  trash: <path d="M4.4 6h11.2M8 6V4.2h4V6M5.8 6l.7 10.2h7l.7-10.2M8.4 9v4.6M11.6 9v4.6" />,
  grip: <path d="M7.6 5h.01M12.4 5h.01M7.6 10h.01M12.4 10h.01M7.6 15h.01M12.4 15h.01" strokeWidth="2.4" />,
  chevronUp: <path d="M4.5 12.5L10 7l5.5 5.5" />,
  copy: (
    <>
      <rect x="7.2" y="7.2" width="9" height="9" rx="1.6" />
      <path d="M12.8 7.2V5a1.6 1.6 0 0 0-1.6-1.6H5A1.6 1.6 0 0 0 3.4 5v6.2A1.6 1.6 0 0 0 5 12.8h2.2" />
    </>
  ),
};

/** Icons that point somewhere and should mirror in right-to-left. */
const DIRECTIONAL: ReadonlySet<IconName> = new Set<IconName>(['arrow', 'chevron', 'undo', 'redo']);

export interface IconProps {
  name: IconName;
  size?: number;
  /** Mirror in RTL. Defaults on for directional icons (arrow, chevron). */
  flip?: boolean;
  className?: string;
  /** Names the icon for assistive tech; without it the icon is decorative. */
  title?: string;
}

export function Icon({ name, size = 20, flip, className, title }: IconProps) {
  const mirrored = flip ?? DIRECTIONAL.has(name);
  const cls = ['icon', mirrored ? 'icon--flip' : '', className ?? ''].filter(Boolean).join(' ');
  return (
    <svg
      className={cls}
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...(title ? { role: 'img', 'aria-label': title } : { 'aria-hidden': true, focusable: false })}
    >
      {PATHS[name]}
    </svg>
  );
}
