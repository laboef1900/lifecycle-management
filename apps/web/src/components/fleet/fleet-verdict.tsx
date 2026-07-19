import type { ClusterResponse, ProcurementInfo } from '@lcm/shared';
import { Link } from '@tanstack/react-router';

import type { FleetSummary } from '@/lib/aggregate-fleet';
import { fleetRunwayToWarn, type RunwaySummary } from '@/lib/forecast-summary';
import { formatGb } from '@/lib/format';
import { formatDateShort } from '@/lib/format-month';
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

/** Underline treatment reserved for the headline's one real link — the cluster name. */
const HL = 'underline decoration-[3px] underline-offset-[3px]';
/**
 * Non-link emphasis in the headline (a numeral, date, or "healthy"/"unknown")
 * used to share {@link HL} with the cluster-name `<Link>`, so plain text read
 * as an identically-styled dead link (finding: "healthy" and the horizon date
 * looked exactly as clickable as the urgent branch's actual `<Link>`). Weight
 * + color carry the emphasis instead; underline is link-exclusive.
 */
const EMPHASIS = 'font-bold';

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
  const utilizationKnown = summary.utilization !== null;
  const headroom = utilizationKnown
    ? Math.max(0, summary.totalCapacity - summary.totalConsumption)
    : null;
  const utilPct = summary.utilization === null ? null : summary.utilization * 100;

  return (
    <section
      className="flex flex-col gap-4 rounded-[var(--radius-card)] border border-border p-5"
      style={{ background: 'var(--surface-card)' }}
      aria-label="Fleet verdict"
    >
      <h1 className="max-w-[56ch] text-balance font-display text-[clamp(22px,2.2vw,28px)] font-semibold leading-[1.18] tracking-[-0.02em]">
        {!utilizationKnown ? (
          <>
            Fleet capacity is <strong className={cn(EMPHASIS, 'text-fg-muted')}>unknown</strong>{' '}
            {'—'}{' '}
            {earliest ? (
              <>
                <Link
                  to="/clusters/$id"
                  params={{ id: earliest.cluster.id }}
                  className={cn(
                    'text-inherit',
                    HL,
                    'decoration-border-strong hover:text-steel hover:decoration-steel',
                  )}
                >
                  {earliest.cluster.name}
                </Link>{' '}
                still needs an order by{' '}
                <strong className={cn(EMPHASIS, 'text-fg-muted')}>
                  {earliest.procurement.orderByDate
                    ? formatDateShort(earliest.procurement.orderByDate)
                    : '—'}
                </strong>
                , but complete capacity before relying on fleet runway.
              </>
            ) : (
              <>add missing capacity before relying on procurement timing.</>
            )}
          </>
        ) : earliest ? (
          <>
            Fleet runway is{' '}
            <strong className={cn(EMPHASIS, 'text-accent')}>
              {runwayMonths(runway, summary.fleetMonths.length)} mo
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
            <strong className={cn(EMPHASIS, 'text-accent')}>
              {earliest.procurement.orderByDate
                ? formatDateShort(earliest.procurement.orderByDate)
                : '—'}
            </strong>
            .
          </>
        ) : (
          <>
            Fleet is <strong className={cn(EMPHASIS, 'text-success')}>healthy</strong> {'—'} no
            orders due in the {summary.fleetMonths.length}-month forecast window.
          </>
        )}
      </h1>

      {/*
        Dividers are drawn structurally (border-l on every instrument but the
        first, sm+ only — matching the old Separator's own `hidden sm:block`)
        rather than as standalone <Separator /> flex items. A standalone
        separator is its own independent flex child, so wrapping at 768px
        could strand it at the end of a line with nothing after it (finding:
        a dangling rule trailing "FLEET 4 CLUSTERS · 8 HOSTS"). Attaching the
        rule to each instrument means it always travels with its own content
        instead of floating disconnected.
      */}
      <div className="flex flex-wrap items-end gap-6 sm:[&>*+*]:border-l sm:[&>*+*]:border-border sm:[&>*+*]:pl-6">
        <Instrument label="Utilization">
          {utilPct === null ? (
            <span className="font-mono text-base font-bold text-fg-muted">UNKNOWN</span>
          ) : (
            <>
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
            </>
          )}
        </Instrument>
        <Instrument label="Headroom">
          <span className="font-mono text-base font-bold tabular-nums text-accent">
            {headroom === null ? 'UNKNOWN' : formatGb(headroom)}
          </span>
        </Instrument>
        <Instrument label="Fleet">
          <span className="font-mono text-base font-bold tabular-nums">
            {hostCount != null
              ? `${summary.clusterCount} CLUSTERS · ${hostCount} HOSTS`
              : summary.clusterCount}
          </span>
        </Instrument>
        <Instrument label="Open orders">
          <span className="font-mono text-base font-bold tabular-nums">
            {openOrderCount > 0
              ? `${openOrderCount} pending`
              : utilizationKnown
                ? 'nothing pending'
                : 'status unknown'}
          </span>
        </Instrument>
        <Instrument label="Baselines" {...(staleCount > 0 ? { className: 'text-warning' } : {})}>
          <span className="font-mono text-base font-bold tabular-nums">
            {staleCount > 0 ? `⚠ ${staleCount} stale` : '✓ all fresh'}
          </span>
        </Instrument>
      </div>
    </section>
  );
}

/**
 * Numeral for the urgent headline. `runway` is the *fleet-wide aggregate*
 * breach (from `fleetRunwayToWarn`), which is independent of `earliest` (the
 * individually-earliest-breaching cluster) — a single urgent cluster can
 * coexist with a fleet aggregate that never breaches at all
 * (`alreadyBreached: false`, `months: null`). Coercing that `null` to `0`
 * (PR review fix 1) rendered the nonsensical "Fleet runway is 0 mo" even
 * though the aggregate is healthy; render "{horizon}+ mo" instead, deriving
 * the horizon from the actual aggregated series length passed in rather than
 * hardcoding the default 24-month window.
 */
function runwayMonths(runway: RunwaySummary, horizonMonths: number): string {
  if (runway.alreadyBreached) return '0';
  if (runway.months !== null) return String(runway.months);
  return `${horizonMonths}+`;
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
