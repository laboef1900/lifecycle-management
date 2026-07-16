import { cn } from '@/lib/utils';

export interface BulletMeterProps {
  /** 0-100, percent of capacity used. */
  value: number;
  /** 0-100, warn threshold position. */
  warn: number;
  /** 0-100, crit threshold position. */
  crit: number;
  /** Overrides the generated accessible name. */
  label?: string;
  className?: string;
}

/**
 * Linear bullet meter (spec §3/§4.2): a filled track with warn/crit threshold
 * ticks. Replaces the retired radial `UtilizationGauge` everywhere — reused by
 * the fleet verdict instrument row and the cluster detail KPI strip.
 */
export function BulletMeter({
  value,
  warn,
  crit,
  label,
  className,
}: BulletMeterProps): React.JSX.Element {
  const clamped = Math.max(0, Math.min(100, value));
  const accessibleLabel =
    label ??
    `Utilization ${value.toFixed(1)} percent of capacity. Warn threshold ${warn} percent, critical ${crit} percent.`;

  return (
    <div
      role="img"
      aria-label={accessibleLabel}
      className={cn('relative h-2 w-full rounded-full bg-muted', className)}
    >
      <span
        data-testid="bullet-meter-fill"
        aria-hidden
        className="absolute inset-y-0 left-0 rounded-full [background:var(--meter-gradient)]"
        style={{
          width: `${clamped}%`,
          boxShadow: '0 0 8px color-mix(in oklab, var(--accent) 40%, transparent)',
        }}
      />
      <span
        data-testid="bullet-meter-warn-tick"
        aria-hidden
        className="absolute -top-0.5 -bottom-0.5 w-0.5 rounded-full bg-warning/70"
        style={{ left: `${warn}%` }}
      />
      <span
        data-testid="bullet-meter-crit-tick"
        aria-hidden
        className="absolute -top-0.5 -bottom-0.5 w-0.5 rounded-full bg-destructive/75"
        style={{ left: `${crit}%` }}
      />
    </div>
  );
}
