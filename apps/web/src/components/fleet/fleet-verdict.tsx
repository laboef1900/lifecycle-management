import type { ClusterResponse, ProcurementInfo } from '@lcm/shared';
import { Link } from '@tanstack/react-router';

import type { FleetSummary } from '@/lib/aggregate-fleet';
import { fleetRunwayToWarn, type RunwaySummary } from '@/lib/forecast-summary';
import { formatGb } from '@/lib/format';
import { formatDateShort, formatMonthLong } from '@/lib/format-month';
import { useEffectiveThresholds } from '@/lib/use-effective-thresholds';
import { cn } from '@/lib/utils';

import { BulletMeter } from './bullet-meter';

export interface FleetVerdictProps {
  summary: FleetSummary;
  /** The cluster whose order-by date is earliest across the fleet, or null when none. */
  earliest: { cluster: ClusterResponse; procurement: ProcurementInfo } | null;
  /** Count of clusters whose baseline is more than 90 days old. */
  staleCount: number;
  /** Count of clusters with an order-by date within 90 days. */
  openOrderCount: number;
  /**
   * Total hosts across clusters with a resolved forecast (spec §4.3's
   * "clusters · hosts" instrument). `null` while forecasts are still loading
   * — the instrument falls back to showing the cluster count alone.
   */
  hostCount: number | null;
}

const HL = 'underline decoration-[3px] underline-offset-[3px]';

/**
 * Fleet verdict panel (spec §4.3): a display-font headline computed from
 * fleet state, plus an instrument sub-deck (utilization bullet meter,
 * headroom, cluster count, open orders, baseline freshness). The headline is
 * the page's only h1.
 */
export function FleetVerdict({
  summary,
  earliest,
  staleCount,
  openOrderCount,
  hostCount,
}: FleetVerdictProps): React.JSX.Element {
  const thresholds = useEffectiveThresholds();
  const runway = fleetRunwayToWarn(
    summary.perClusterSeries.map((s) => s.months),
    thresholds,
  );
  const horizonMonth = summary.fleetMonths.at(-1)?.month;
  const headroom = Math.max(0, summary.totalCapacity - summary.totalConsumption);
  const utilPct = summary.utilization * 100;

  return (
    <section
      className="flex flex-col gap-4 rounded-[var(--radius-card)] border border-border p-5"
      style={{ background: 'var(--surface-card)' }}
      aria-label="Fleet verdict"
    >
      <h1 className="max-w-[56ch] text-balance font-display text-[clamp(22px,2.2vw,28px)] font-semibold leading-[1.18] tracking-[-0.02em]">
        {earliest ? (
          <>
            Fleet runway is{' '}
            <strong className={cn('text-accent', HL, 'decoration-accent')}>
              {runwayMonths(runway)} mo
            </strong>{' '}
            {'—'}{' '}
            <Link
              to="/clusters/$id"
              params={{ id: earliest.cluster.id }}
              className={cn(
                'text-inherit',
                HL,
                'decoration-accent hover:text-steel hover:decoration-steel',
              )}
            >
              {earliest.cluster.name}
            </Link>{' '}
            needs an order by{' '}
            <strong className={cn('text-accent', HL, 'decoration-accent')}>
              {earliest.procurement.orderByDate
                ? formatDateShort(earliest.procurement.orderByDate)
                : '—'}
            </strong>
            .
          </>
        ) : (
          <>
            Fleet is{' '}
            <strong className={cn('text-success', HL, 'decoration-success')}>healthy</strong> {'—'}{' '}
            no orders due before{' '}
            <strong className={cn('text-success', HL, 'decoration-success')}>
              {horizonMonth ? formatMonthLong(horizonMonth) : 'the forecast horizon'}
            </strong>
            .
          </>
        )}
      </h1>

      <div className="flex flex-wrap items-end gap-6">
        <Instrument label="Utilization">
          <span className="font-mono text-base font-bold tabular-nums text-accent">
            {utilPct.toFixed(1)}%
          </span>
          <BulletMeter
            value={utilPct}
            warn={thresholds.warn * 100}
            crit={thresholds.crit * 100}
            className="mt-1.5 w-[150px]"
            label={`Fleet utilization ${utilPct.toFixed(1)} percent of capacity. Warn threshold ${Math.round(thresholds.warn * 100)} percent, critical ${Math.round(thresholds.crit * 100)} percent.`}
          />
        </Instrument>
        <Separator />
        <Instrument label="Headroom">
          <span className="font-mono text-base font-bold tabular-nums text-accent">
            {formatGb(headroom)}
          </span>
        </Instrument>
        <Separator />
        <Instrument label="Clusters">
          <span className="font-mono text-base font-bold tabular-nums">
            {hostCount != null
              ? `${summary.clusterCount} CLUSTERS · ${hostCount} HOSTS`
              : summary.clusterCount}
          </span>
        </Instrument>
        <Separator />
        <Instrument label="Open orders">
          <span className="font-mono text-base font-bold tabular-nums">
            {openOrderCount > 0 ? `${openOrderCount} pending` : 'nothing pending'}
          </span>
        </Instrument>
        <Separator />
        <Instrument label="Baselines" {...(staleCount > 0 ? { className: 'text-warning' } : {})}>
          <span className="font-mono text-base font-bold tabular-nums">
            {staleCount > 0 ? `⚠ ${staleCount} stale` : '✓ all fresh'}
          </span>
        </Instrument>
      </div>
    </section>
  );
}

function runwayMonths(runway: RunwaySummary): number {
  if (runway.alreadyBreached) return 0;
  return runway.months ?? 0;
}

function Instrument({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <div className={cn('flex min-w-0 flex-col gap-0.5', className)}>
      <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-fg-subtle">
        {label}
      </span>
      {children}
    </div>
  );
}

function Separator(): React.JSX.Element {
  return <span aria-hidden className="hidden h-8 w-px self-stretch bg-border sm:block" />;
}
