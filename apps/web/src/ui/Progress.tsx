export interface ProgressProps {
  /** 0..1. Leave out for an indeterminate bar (work of unknown length). */
  value?: number;
  label: string;
}

export function Progress({ value, label }: ProgressProps) {
  const determinate = typeof value === 'number';
  const pct = determinate ? Math.round(Math.min(1, Math.max(0, value)) * 100) : undefined;
  return (
    <div
      className="progress"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      {...(pct !== undefined ? { 'aria-valuenow': pct } : {})}
      data-indeterminate={determinate ? undefined : 'true'}
    >
      <div className="progress__bar" style={pct !== undefined ? { inlineSize: `${pct}%` } : undefined} />
    </div>
  );
}
