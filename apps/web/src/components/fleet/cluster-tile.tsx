import type { ForecastResponse, LiveUsage } from '@lcm/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Archive } from 'lucide-react';
import { memo } from 'react';

import { AcknowledgedAnnotation } from '@/components/detail/recommendation-chip';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { utilStatus, type ClusterForecastEntry } from '@/lib/forecast-summary';
import { RUNWAY_UNIT } from '@/lib/format';
import { formatDateShort, formatMonthShort } from '@/lib/format-month';
import { cn } from '@/lib/utils';

import { ClusterTileChart } from './cluster-tile-chart';
import {
  describeLiveUsage,
  LiveUsageInline,
  ProvisionalHostHint,
  SyncStateBadge,
} from './live-usage';
import { formatRelativeDays, orderByUrgency } from './order-by-rail';
import { baselineAgeDays, isBaselineStale } from './stale-baseline';

export interface ClusterTileProps {
  entry: ClusterForecastEntry;
  /** Full forecast (procurement + events) for this cluster; undefined while loading or on error. */
  forecast: ForecastResponse | undefined;
  thresholds: { warn: number; crit: number };
  /** Highlights the tile — the order-by rail links back to its tile on hover/focus. */
  linked?: boolean;
  /**
   * This cluster's live-usage reading from the fleet batch. `undefined` for a
   * manual cluster (never in the batch) or while the batch is still loading —
   * `liveUsagePending` disambiguates the two for the synced case.
   */
  live?: LiveUsage | undefined;
  liveUsagePending?: boolean;
}

const STATUS_BADGE: Record<
  'ok' | 'warn' | 'crit' | 'unknown',
  { variant: 'success' | 'warning' | 'danger' | 'outline'; label: string }
> = {
  ok: { variant: 'success', label: 'OK' },
  warn: { variant: 'warning', label: 'WARN' },
  crit: { variant: 'danger', label: 'CRIT' },
  // Capacity 0 ⇒ utilization unknowable. Neutral outline, not a green "OK" (#200).
  unknown: { variant: 'outline', label: 'UNKNOWN' },
};

const ORDER_BADGE_VARIANT: Record<'now' | 'soon' | 'planned', 'danger' | 'warning' | 'outline'> = {
  now: 'danger',
  soon: 'warning',
  planned: 'outline',
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
  /**
   * Whole-month crit-breach date, set only when `pastLabel === 'warn'` and a
   * later in-window month also crosses crit. Per the spec's recorded
   * amendment, the runway numeral tracks warn (not crit) once warn has been
   * breached — this surfaces the crit month in the sub-line/verdict text
   * only, never promoting the numeral to a "to crit" countdown (PR review
   * fix 2: the numeral previously contradicted the panel's "Over 70%"
   * RunwayPill for this exact state).
   */
  pastCritDate: string | null;
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

  if (summary.alreadyBreached === 'crit') {
    if (critIndex >= 0) {
      return {
        value: critIndex,
        plus: false,
        breachLabel: 'crit',
        breachDate: months[critIndex]!.month,
        pastLabel: null,
        pastThresholdPct: null,
        pastCritDate: null,
      };
    }
    // Already past crit as of the current month, but no month in the window
    // crosses crit again — the numeral reads "{horizon}+ MO" (nothing
    // further to project), but the sub-line/verdict must not claim "no
    // breach": the cluster is already in breach right now.
    return {
      value: horizon,
      plus: true,
      breachLabel: null,
      breachDate: null,
      pastLabel: 'crit',
      pastThresholdPct: Math.round(thresholds.crit * 100),
      pastCritDate: null,
    };
  }
  if (summary.alreadyBreached === 'warn') {
    // Already past warn as of the current month. The numeral always keeps
    // the "past warn" treatment here — even when a later in-window month
    // also crosses crit, that crit month surfaces only in the sub-line and
    // verdict text below, never as a "to crit" countdown numeral.
    return {
      value: horizon,
      plus: true,
      breachLabel: null,
      breachDate: null,
      pastLabel: 'warn',
      pastThresholdPct: Math.round(thresholds.warn * 100),
      pastCritDate: critIndex >= 0 ? months[critIndex]!.month : null,
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
      pastCritDate: null,
    };
  }
  return {
    value: horizon,
    plus: true,
    breachLabel: null,
    breachDate: null,
    pastLabel: null,
    pastThresholdPct: null,
    pastCritDate: null,
  };
}

/**
 * Uniform fleet-console tile (spec §4.4): name + status chip, runway numeral,
 * order-by chip, one-line verdict, a stale-baseline flag chip, and the
 * compact forecast chart. Renders a non-link error state when the forecast
 * failed to load.
 *
 * #291 (2026-07-22): the tile no longer carries a visible event-in-window
 * signal — the `EVENT ×n` chip was removed outright (owner decision, not a
 * relocation). Event data still reaches the tile's aria-label (below) and,
 * in full, the cluster detail panel's `ForecastChart`.
 *
 * Wrapped in `memo` (PR review fix 4d) so mousing across the fleet grid —
 * which only flips one tile's `linked` prop via `fleet-console.tsx`'s hover
 * state — doesn't force every other tile's chart to re-render along with it.
 */
export const ClusterTile = memo(function ClusterTile({
  entry,
  forecast,
  thresholds,
  linked = false,
  live,
  liveUsagePending = false,
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

  // Preserve null (capacity 0 ⇒ unknowable); never `?? 0`, which reads as "0% used,
  // healthy" — the Q9d lie on a purchasing surface (#200).
  const currentUtil = cluster.metrics[0]?.utilization ?? null;
  const status = utilStatus(currentUtil, thresholds);
  const badge = STATUS_BADGE[status];
  const utilText =
    currentUtil === null
      ? 'Utilization unknown (no capacity recorded)'
      : `${(currentUtil * 100).toFixed(1)}% used`;
  const orderByDate = forecast?.procurement.orderByDate ?? null;
  const urgency = orderByUrgency(orderByDate);
  const isArchived = Boolean(cluster.archivedAt);
  const runway = computeRunway(entry, thresholds);
  const runwayUnknown =
    currentUtil === null && runway.breachLabel === null && runway.pastLabel === null;
  const orderUnknown = currentUtil === null && orderByDate === null;
  const stale = isBaselineStale(cluster.baselineDate);
  const ageDays = baselineAgeDays(cluster.baselineDate);
  const events = forecast?.events ?? [];
  // The acknowledgment covering the live breach, or null (#292, surfaced on
  // the fleet tile too by #302 — follow-up to #292/#300, which shipped it
  // only in the detail panel's RecommendationChip). Server-side, this is
  // already null unless a still-covering approval exists, so no extra
  // "hasLiveBreach" gating is needed here.
  const acknowledgment = !isArchived ? (forecast?.acknowledgment ?? null) : null;

  const runwaySub = runwayUnknown
    ? 'capacity unknown'
    : runway.breachLabel
      ? `to ${runway.breachLabel} ${formatMonthShort(runway.breachDate!)}`
      : runway.pastLabel === 'warn'
        ? runway.pastCritDate
          ? `past warn ${runway.pastThresholdPct}% — crit ≈ ${formatMonthShort(runway.pastCritDate)}`
          : `past warn ${runway.pastThresholdPct}% — crit beyond window`
        : runway.pastLabel === 'crit'
          ? `past crit ${runway.pastThresholdPct}%`
          : 'no breach';
  const verdict = runwayUnknown
    ? // Names the destination, not just the problem (#243 audit): a synced
      // cluster with no recorded host capacity is a dead end otherwise.
      `${utilText} — add host capacity to calculate runway.`
    : runway.breachLabel
      ? `${utilText} — reaches ${runway.breachLabel} ≈ ${formatMonthShort(runway.breachDate!)}.`
      : runway.pastLabel === 'warn'
        ? runway.pastCritDate
          ? `${utilText} — already past warn; reaches crit ≈ ${formatMonthShort(runway.pastCritDate)}.`
          : `${utilText} — already past warn; crit beyond the ${runway.value}-month window.`
        : runway.pastLabel === 'crit'
          ? `${utilText} — already past crit.`
          : // `runway.value` is the exact horizon length here (the numeral's
            // own "+" marks an open-ended countdown; this sentence describes
            // a fixed window boundary and must not inherit it — it previously
            // read "no breach in the 24+-month window" on a 24-month window).
            `${utilText} — no breach in the ${runway.value}-month window.`;

  // Live usage / sync summary, appended so assistive tech hears it — the tile's
  // aria-label overrides its visible content, so the visible LIVE line below
  // would otherwise be silent.
  const liveSummary = isArchived ? '' : describeLiveUsage(cluster, live);
  const provisionalCount = cluster.provisionalHostCount ?? 0;

  const ariaLabel = [
    currentUtil === null
      ? `${cluster.name}: utilization unknown, no capacity recorded`
      : `${cluster.name}: ${(currentUtil * 100).toFixed(1)} percent utilized`,
    isArchived
      ? 'archived — no forecast'
      : runwayUnknown
        ? // Names the destination for the a11y path too, matching the visible
          // verdict above: the screen-reader user is the one who can least
          // afford this dead end, and aria-label overrides the tile's visible
          // content, so leaving it at "capacity required" hid the only fix.
          'runway unknown — add host capacity to calculate breach timing'
        : `runway ${runway.value}${runway.plus ? '+' : ''} months ${runwaySub}`,
    orderByDate
      ? `order by ${formatDateShort(orderByDate)} (${formatRelativeDays(orderByDate)})`
      : orderUnknown
        ? 'order status unknown — capacity required'
        : 'no order needed',
    // The visible AcknowledgedAnnotation's text doesn't otherwise reach
    // assistive tech — the tile's aria-label overrides all visible content
    // (#302, same rationale as every other segment in this array).
    acknowledgment ? `order acknowledged by ${acknowledgment.approvedByLabel}` : null,
    // #291 (2026-07-22): the visible EVENT chip this segment used to describe
    // was removed from the tile entirely (owner decision — not merely
    // relocated, as it was under #268). This aria-label segment is now the
    // fleet console's ONLY surviving event-in-window signal, visible or not:
    // assistive tech must not regress below what sighted users already lost.
    !isArchived && events.length > 0
      ? `${events.length} event${events.length === 1 ? '' : 's'} in the forecast window`
      : null,
    stale ? `baseline ${ageDays} days old — re-measure` : null,
    liveSummary || null,
    !isArchived && provisionalCount > 0
      ? `${provisionalCount} host${provisionalCount === 1 ? '' : 's'} need commissioning dates`
      : null,
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
        {/* Icon + text, never the tile's dimming alone (#243, WCAG 1.4.1). */}
        {cluster.archivedAt ? (
          <Badge variant="outline">
            <Archive className="h-3 w-3" aria-hidden />
            Archived
          </Badge>
        ) : null}
        {!isArchived ? <SyncStateBadge cluster={cluster} /> : null}
        {/*
          Spec §4.4 amendment (2026-07-20, #268): the order-by chip moves up
          here from the runway row. It is the tile's single most decision-bearing
          fact on a purchasing surface, so it belongs on the identity line beside
          the name and status — and vacating the runway row is what frees a whole
          chip row for the chart.

          Spec §4.4 amendment (2026-07-19, #243 Part B): the chip renders
          only when there's something to say — a real order-by date, or the
          unknown-capacity case (still an information-bearing state, unlike
          the old "— · NO ORDER NEEDED" placeholder, which just repeated the
          all-clear a tile had already stated three other ways).

          #290: restyled onto the shared `Badge` (matching the status and
          vSphere badges) and moved into their cluster instead of being
          pushed to the row's far edge via `ml-auto`. The relative-days
          suffix (`· 12 D OVERDUE`) is dropped from the visible label — the
          badge's color tone already conveys urgency, and the aria-label
          below still carries the relative-days detail for assistive tech.
        */}
        {orderByDate || orderUnknown ? (
          <Badge
            variant={
              orderByDate
                ? ORDER_BADGE_VARIANT[urgency === 'none' ? 'planned' : urgency]
                : 'outline'
            }
          >
            {orderByDate
              ? `ORDER BY ${formatDateShort(orderByDate).toUpperCase()}`
              : 'ORDER STATUS UNKNOWN'}
          </Badge>
        ) : null}
        {/*
          #302 (follow-up to #292/#300): the order-approval acknowledgment
          also needs to be visible on the fleet tile, not just the cluster
          detail panel. Reuses `RecommendationChip`'s own
          `AcknowledgedAnnotation` directly — same icon (`BadgeCheck`), same
          success tone + "Ack" text (never color alone), same tooltip/sr-only
          detail, and the same underlying `ForecastAcknowledgment` data —
          rather than inventing a tile-only variant of the same treatment.
        */}
        {acknowledgment ? <AcknowledgedAnnotation acknowledgment={acknowledgment} /> : null}
      </div>

      {/*
        `items-baseline` (was `items-end`) so the runway sub-line sits on the
        same baseline as the numeral's inline unit — under `items-end` the
        sub-line carried a `pb-1` nudge that left it visibly stepped above the
        'mo' it qualifies (#268).
      */}
      <div className="flex flex-wrap items-baseline gap-2">
        {isArchived ? (
          <span
            className="font-mono text-[28px] font-bold leading-none tracking-tight text-fg-muted"
            aria-label="archived — no forecast"
          >
            —
          </span>
        ) : runwayUnknown ? (
          <>
            <span className="font-mono text-[28px] font-bold leading-none tracking-tight text-fg-muted">
              —
            </span>
            <span className="font-mono text-[10px] text-fg-muted">{runwaySub}</span>
          </>
        ) : (
          <>
            <span className="font-mono text-[28px] font-bold leading-none tracking-tight text-accent">
              {runway.value}
              {runway.plus ? '+' : ''}
              <span className="ml-1 text-xs font-semibold text-fg-muted">{RUNWAY_UNIT}</span>
            </span>
            <span className="font-mono text-[10px] text-fg-muted">{runwaySub}</span>
          </>
        )}
      </div>

      <p className="text-[11px] leading-[1.45] text-fg-muted">
        {isArchived ? 'Archived — no forecast.' : verdict}
      </p>

      {!isArchived && cluster.connection ? (
        <LiveUsageInline cluster={cluster} live={live} isPending={liveUsagePending} />
      ) : null}

      {/*
        The event chip that used to live here left for the runway row under
        #268, then was removed from the tile altogether under #291 — so on a
        healthy tile both remaining children (provisional-host hint,
        stale-baseline chip) are absent and the row collapses — rendered
        conditionally rather than as an always-present empty flex box, whose
        `gap` would otherwise still consume height the chart now uses.
      */}
      {(!isArchived && provisionalCount > 0) || stale ? (
        <div className="flex flex-wrap gap-1">
          {!isArchived ? <ProvisionalHostHint count={provisionalCount} /> : null}
          {/*
          Spec §4.4 amendment (2026-07-19, #243 Part B): the baseline chip
          now renders only in its stale/warn variant — a fresh baseline
          repeating its date on every tile added no information the
          "BASELINES ✓ all fresh" verdict instrument didn't already state.
          That leaves FlagChip with a single (warn) tone — its muted variant
          is gone, not just unused.
        */}
          {stale ? <FlagChip>⚠ BASELINE {ageDays} D OLD</FlagChip> : null}
        </div>
      ) : null}

      <div className="mt-auto">
        <ClusterTileChart months={entry.months} thresholds={thresholds} orderByDate={orderByDate} />
      </div>
    </Link>
  );
});

function FlagChip({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <span
      className={cn(
        'rounded-sm border border-warning/35 px-1.5 py-0.5 font-mono text-[10px] font-semibold tracking-[0.05em] text-warning',
        className,
      )}
    >
      {children}
    </span>
  );
}
