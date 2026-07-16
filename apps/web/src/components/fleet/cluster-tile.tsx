import type { ForecastResponse } from '@lcm/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { utilStatus, type ClusterForecastEntry } from '@/lib/forecast-summary';
import { formatMonthShort } from '@/lib/format-month';
import { cn } from '@/lib/utils';

import { ClusterTileChart } from './cluster-tile-chart';
import { formatRelativeDays, orderByUrgency } from './order-by-rail';
import { baselineAgeDays, isBaselineStale } from './stale-baseline';

export interface ClusterTileProps {
  entry: ClusterForecastEntry;
  /** Full forecast (procurement + events) for this cluster; undefined while loading or on error. */
  forecast: ForecastResponse | undefined;
  thresholds: { warn: number; crit: number };
  /** Highlights the tile — the order-by rail links back to its tile on hover/focus. */
  linked?: boolean;
}

const STATUS_BADGE: Record<
  'ok' | 'warn' | 'crit',
  { variant: 'success' | 'warning' | 'danger'; label: string }
> = {
  ok: { variant: 'success', label: 'OK' },
  warn: { variant: 'warning', label: 'WARN' },
  crit: { variant: 'danger', label: 'CRIT' },
};

const ORDER_CHIP_TONE: Record<'now' | 'soon' | 'planned', string> = {
  now: 'border-destructive/40 bg-destructive/10 text-destructive',
  soon: 'border-warning/40 bg-warning/10 text-warning',
  planned: 'border-border text-fg-muted',
};

interface RunwayInfo {
  value: number;
  plus: boolean;
  breachLabel: 'crit' | 'warn' | null;
  breachDate: string | null;
  /**
   * Set when the cluster is already past a threshold (warn or crit) and no
   * further crossing was found in-window — distinguishes "already breached,
   * nothing more to project" from a genuinely unbreached cluster, both of
   * which otherwise share the same {@link value}/{@link plus} numeral.
   */
  pastLabel: 'warn' | 'crit' | null;
  /** Whole-percent threshold that `pastLabel` refers to (e.g. 70 for warn). */
  pastThresholdPct: number | null;
}

function computeRunway(
  entry: ClusterForecastEntry,
  thresholds: { warn: number; crit: number },
): RunwayInfo {
  const { summary, months } = entry;
  const horizon = months.length;
  const critIndex = months.findIndex(
    (m) => m.capacity > 0 && m.consumption / m.capacity >= thresholds.crit,
  );

  if (summary.alreadyBreached) {
    if (critIndex >= 0) {
      return {
        value: critIndex,
        plus: false,
        breachLabel: 'crit',
        breachDate: months[critIndex]!.month,
        pastLabel: null,
        pastThresholdPct: null,
      };
    }
    // Already past warn (or crit) as of the current month, but no month in
    // the window crosses crit — the numeral still reads "{horizon}+ MO"
    // (nothing further to project), but the sub-line/verdict must not claim
    // "no breach": the fleet is already in breach right now.
    const pastLabel = summary.alreadyBreached;
    return {
      value: horizon,
      plus: true,
      breachLabel: null,
      breachDate: null,
      pastLabel,
      pastThresholdPct: Math.round(thresholds[pastLabel] * 100),
    };
  }
  if (summary.months !== null) {
    return {
      value: summary.months,
      plus: false,
      breachLabel: 'warn',
      breachDate: months[summary.months]!.month,
      pastLabel: null,
      pastThresholdPct: null,
    };
  }
  return {
    value: horizon,
    plus: true,
    breachLabel: null,
    breachDate: null,
    pastLabel: null,
    pastThresholdPct: null,
  };
}

/**
 * Uniform fleet-console tile (spec §4.4): name + status chip, runway numeral,
 * order-by chip, one-line verdict, flag chips (event-in-window, stale
 * baseline), and the compact forecast chart. Renders a non-link error state
 * when the forecast failed to load.
 */
export function ClusterTile({
  entry,
  forecast,
  thresholds,
  linked = false,
}: ClusterTileProps): React.JSX.Element {
  const { cluster } = entry;
  const queryClient = useQueryClient();

  if (entry.error) {
    return (
      <div
        data-cluster-id={cluster.id}
        className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-destructive/30 p-3.5"
        style={{ background: 'var(--surface-card)' }}
      >
        <span className="min-w-0 truncate font-display text-sm font-semibold tracking-tight">
          {cluster.name}
        </span>
        <p className="text-xs text-destructive">Forecast unavailable — {entry.error}</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() =>
            void queryClient.invalidateQueries({
              predicate: (query) =>
                query.queryKey[0] === 'forecast' && query.queryKey[1] === cluster.id,
            })
          }
        >
          Retry
        </Button>
      </div>
    );
  }

  const currentUtil = cluster.metrics[0]?.utilization ?? 0;
  const status = utilStatus(currentUtil, thresholds);
  const badge = STATUS_BADGE[status];
  const orderByDate = forecast?.procurement.orderByDate ?? null;
  const urgency = orderByUrgency(orderByDate);
  const isArchived = Boolean(cluster.archivedAt);
  const runway = computeRunway(entry, thresholds);
  const stale = isBaselineStale(cluster.baselineDate);
  const ageDays = baselineAgeDays(cluster.baselineDate);
  const events = forecast?.events ?? [];

  const runwaySub = runway.breachLabel
    ? `to ${runway.breachLabel} ${formatMonthShort(runway.breachDate!)}`
    : runway.pastLabel === 'warn'
      ? `past warn ${runway.pastThresholdPct}% — crit beyond window`
      : runway.pastLabel === 'crit'
        ? `past crit ${runway.pastThresholdPct}%`
        : 'no breach';
  const verdict = runway.breachLabel
    ? `${(currentUtil * 100).toFixed(1)}% used — reaches ${runway.breachLabel} ≈ ${formatMonthShort(runway.breachDate!)}.`
    : runway.pastLabel === 'warn'
      ? `${(currentUtil * 100).toFixed(1)}% used — already past warn; crit beyond the ${runway.value}-month window.`
      : runway.pastLabel === 'crit'
        ? `${(currentUtil * 100).toFixed(1)}% used — already past crit.`
        : `${(currentUtil * 100).toFixed(1)}% used — no breach in the ${runway.value}${runway.plus ? '+' : ''}-month window.`;

  const ariaLabel = [
    `${cluster.name}: ${(currentUtil * 100).toFixed(1)} percent utilized`,
    isArchived
      ? 'archived — no forecast'
      : `runway ${runway.value}${runway.plus ? '+' : ''} months ${runwaySub}`,
    orderByDate
      ? `order by ${orderByDate} (${formatRelativeDays(orderByDate)})`
      : 'no order needed',
    stale ? `baseline ${ageDays} days old — re-measure` : null,
    'Open detail.',
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <Link
      to="/clusters/$id"
      params={{ id: cluster.id }}
      data-cluster-id={cluster.id}
      aria-label={ariaLabel}
      className={cn(
        'group flex flex-col gap-2 rounded-[var(--radius-card)] border border-border p-3.5 transition-[background,border-color,box-shadow,transform] duration-150 hover:-translate-y-px hover:border-border-strong',
        cluster.archivedAt && 'opacity-60',
        linked &&
          'border-steel/70 shadow-[0_0_0_1px_color-mix(in_oklab,var(--steel)_30%,transparent)]',
      )}
      style={{ background: 'var(--surface-card)' }}
    >
      <div className="flex flex-wrap items-center gap-2 pr-2">
        <span className="min-w-0 truncate font-display text-sm font-semibold tracking-tight">
          {cluster.name}
        </span>
        <Badge variant={badge.variant} dot>
          {badge.label}
        </Badge>
        {cluster.archivedAt ? <Badge variant="outline">Archived</Badge> : null}
      </div>

      <div className="flex flex-wrap items-end gap-2">
        {isArchived ? (
          <span
            className="font-mono text-[28px] font-bold leading-none tracking-tight text-fg-muted"
            aria-label="archived — no forecast"
          >
            —
          </span>
        ) : (
          <>
            <span className="font-mono text-[28px] font-bold leading-none tracking-tight text-accent">
              {runway.value}
              {runway.plus ? '+' : ''}
              <span className="ml-1 text-xs font-semibold text-fg-muted">MO</span>
            </span>
            <span className="pb-1 font-mono text-[10px] text-fg-muted">{runwaySub}</span>
          </>
        )}
        <span
          className={cn(
            'ml-auto rounded border px-1.5 py-0.5 font-mono text-[9.5px] font-bold tracking-[0.08em]',
            orderByDate
              ? ORDER_CHIP_TONE[urgency === 'none' ? 'planned' : urgency]
              : 'border-border text-fg-muted',
          )}
        >
          {orderByDate
            ? `ORDER BY ${orderByDate} · ${formatRelativeDays(orderByDate).toUpperCase()}`
            : '— · NO ORDER NEEDED'}
        </span>
      </div>

      <p className="text-[11px] leading-[1.45] text-fg-muted">
        {isArchived ? 'Archived — no forecast.' : verdict}
      </p>

      <div className="flex flex-wrap gap-1">
        {events.length > 0 ? (
          <FlagChip tone="warn">
            EVENT ×{events.length}
            {events[0]
              ? ` · ${formatMonthShort(`${events[0].effectiveDate.slice(0, 7)}-01`).toUpperCase()}`
              : ''}
          </FlagChip>
        ) : null}
        {stale ? (
          <FlagChip tone="warn">⚠ BASELINE {ageDays} D OLD</FlagChip>
        ) : (
          <FlagChip tone="muted">BASELINE {cluster.baselineDate}</FlagChip>
        )}
      </div>

      <div className="mt-auto">
        <ClusterTileChart months={entry.months} thresholds={thresholds} orderByDate={orderByDate} />
      </div>
    </Link>
  );
}

function FlagChip({
  tone,
  children,
}: {
  tone: 'warn' | 'muted';
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <span
      className={cn(
        'rounded-sm border px-1.5 py-0.5 font-mono text-[9px] font-semibold tracking-[0.05em]',
        tone === 'warn' ? 'border-warning/35 text-warning' : 'border-border text-fg-muted',
      )}
    >
      {children}
    </span>
  );
}
