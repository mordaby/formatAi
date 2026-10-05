// One small chart of the overview: the estimated AI cost per UTC day, as a row of thin bars (inline SVG, no chart library). One series, so no
// legend; the figure is named by its label, the highest day is written out, every bar says its day and cost on hover, and the same numbers are
// in a table beside it ("Show the numbers by day"). A day with no priced call has no bar (it is "n/a", not zero).
import type { AdminDayRow } from '@formatai/shared';

const W = 360;
const H = 110;
const TOP = 16;
const BASE = 88;
const MAX_BAR = 14;
const RADIUS = 3;

export interface CostChartProps {
  rows: readonly AdminDayRow[];
  /** What the figure is, for assistive technology. */
  label: string;
  /** What a hover on a day says. */
  tip(row: AdminDayRow): string;
  /** The label of the top of the scale (the highest day). */
  maxText: string;
}

/** A bar with its data end rounded and its baseline end square. */
function barPath(x: number, y: number, w: number): string {
  const h = BASE - y;
  const r = Math.min(RADIUS, h / 2, w / 2);
  return `M${x},${BASE} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${BASE} Z`;
}

export function CostChart({ rows, label, tip, maxText }: CostChartProps) {
  const max = Math.max(0, ...rows.map((r) => r.costUsd ?? 0));
  const slot = W / Math.max(1, rows.length);
  const width = Math.min(MAX_BAR, slot * 0.6);
  const first = rows[0];
  const last = rows[rows.length - 1];

  return (
    <div className="chart" dir="ltr">
      <svg className="chart__svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} preserveAspectRatio="xMidYMid meet">
        <text className="chart__text" x={0} y={10}>
          {maxText}
        </text>
        <line className="chart__axis" x1={0} x2={W} y1={BASE} y2={BASE} />
        {rows.map((row, i) => {
          const x = i * slot + (slot - width) / 2;
          const height = max > 0 && row.costUsd !== null && row.costUsd > 0 ? Math.max(2, ((BASE - TOP) * row.costUsd) / max) : 0;
          return (
            <g key={row.day} className="chart__day" data-day={row.day}>
              {height > 0 ? <path className="chart__bar" d={barPath(x, BASE - height, width)} /> : null}
              {/* the hover target is the whole slot, taller than the mark */}
              <rect className="chart__hit" x={i * slot} y={0} width={slot} height={BASE} />
              <title>{tip(row)}</title>
            </g>
          );
        })}
        {first && last ? (
          <>
            <text className="chart__text" x={0} y={H - 4}>
              {first.day}
            </text>
            <text className="chart__text" x={W} y={H - 4} textAnchor="end">
              {last.day}
            </text>
          </>
        ) : null}
      </svg>
    </div>
  );
}
