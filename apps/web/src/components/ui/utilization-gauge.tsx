import * as React from 'react';

import { cn } from '@/lib/utils';

export type GaugeSize = 'sm' | 'md' | 'lg';

interface UtilizationGaugeProps extends React.SVGAttributes<SVGSVGElement> {
  /** 0..1 ratio (consumption / capacity), or undefined when there is no data. */
  value: number | undefined;
  size?: GaugeSize;
}

const DIMENSIONS: Record<GaugeSize, { px: number; stroke: number; font: string }> = {
  sm: { px: 28, stroke: 4, font: 'text-[9px]' },
  md: { px: 56, stroke: 6, font: 'text-xs' },
  lg: { px: 96, stroke: 9, font: 'text-base' },
};

function bandOf(value: number): 'ok' | 'warning' | 'critical' {
  if (value >= 0.9) return 'critical';
  if (value >= 0.7) return 'warning';
  return 'ok';
}

function nextBandOf(band: 'ok' | 'warning' | 'critical'): 'warning' | 'critical' {
  return band === 'ok' ? 'warning' : 'critical';
}

const FILL: Record<'ok' | 'warning' | 'critical', string> = {
  ok: 'var(--fg-muted)',
  warning: 'var(--warning)',
  critical: 'var(--destructive)',
};

export function UtilizationGauge({
  value,
  size = 'md',
  className,
  ...props
}: UtilizationGaugeProps): React.JSX.Element {
  const { px, stroke, font } = DIMENSIONS[size];
  const radius = (px - stroke) / 2;
  const cx = px / 2;
  const cy = px / 2;
  const circumference = 2 * Math.PI * radius;

  const hasValue = typeof value === 'number' && Number.isFinite(value);
  const clamped = hasValue ? Math.min(Math.max(value, 0), 1) : 0;
  const band = hasValue ? bandOf(clamped) : null;
  const nextBand = band ? nextBandOf(band) : null;

  const label = hasValue ? `${(clamped * 100).toFixed(1)}%, status: ${band}` : '—, status: empty';

  return (
    <div className={cn('relative inline-flex items-center justify-center', className)}>
      <svg
        role="img"
        aria-label={label}
        width={px}
        height={px}
        viewBox={`0 0 ${px} ${px}`}
        className="-rotate-90"
        {...props}
      >
        {/* Unfilled track is tinted with the next band's color to signal proximity to the next threshold. */}
        <circle
          cx={cx}
          cy={cy}
          r={radius}
          fill="none"
          stroke={nextBand ? FILL[nextBand] : 'var(--border)'}
          strokeOpacity={nextBand ? 0.18 : 1}
          strokeWidth={stroke}
        />
        {hasValue && band ? (
          <circle
            cx={cx}
            cy={cy}
            r={radius}
            fill="none"
            stroke={FILL[band]}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${circumference * clamped} ${circumference}`}
          />
        ) : null}
      </svg>
      <span aria-hidden className={cn('absolute font-mono font-semibold tabular-nums', font)}>
        {hasValue ? `${(clamped * 100).toFixed(1)}%` : '—'}
      </span>
    </div>
  );
}
