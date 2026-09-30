export interface SpinnerProps {
  size?: number;
  /** Announced to assistive tech; without it the spinner is decorative. */
  label?: string;
}

export function Spinner({ size = 20, label }: SpinnerProps) {
  return (
    <svg
      className="spinner"
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      {...(label ? { role: 'status', 'aria-label': label } : { 'aria-hidden': true })}
    >
      <circle cx="10" cy="10" r="7.5" opacity="0.2" />
      <path d="M10 2.5a7.5 7.5 0 0 1 7.5 7.5" />
    </svg>
  );
}
