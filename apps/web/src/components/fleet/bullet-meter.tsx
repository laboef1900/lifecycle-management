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
      {/* Threshold ticks (#243 Part B): each carries a 1px halo in the card
          surface color so it survives ANY fill underneath — in dark theme
          --warning and --accent resolve to the same hex, so an un-haloed warn
          tick vanishes into the amber fill exactly at warn breach. Crit is
          taller than warn (protrudes 4px vs 2px past the track): shape, not
          hue alone, separates the two severities (WCAG 1.4.1). */}
      <span
        data-testid="bullet-meter-warn-tick"
        aria-hidden
        className="absolute -top-0.5 -bottom-0.5 w-0.5 rounded-full bg-warning shadow-[0_0_0_1px_var(--card)]"
        style={{ left: `${warn}%` }}
      />
      <span
        data-testid="bullet-meter-crit-tick"
        aria-hidden
        className="absolute -top-1 -bottom-1 w-0.5 rounded-full bg-destructive shadow-[0_0_0_1px_var(--card)]"
        style={{ left: `${crit}%` }}
      />
    </div>
  );
}
