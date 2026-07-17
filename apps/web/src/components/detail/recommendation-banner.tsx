import type { ProcurementInfo } from '@lcm/shared';

import { formatRelativeDays } from '@/components/fleet/order-by-rail';
import { daysUntil } from '@/lib/dates';
import { deriveProcurementKpi } from '@/lib/procurement-kpi';
import { cn } from '@/lib/utils';

export interface RecommendationBannerProps {
  procurement: ProcurementInfo;
  today?: Date;
}

type Tone = 'crit' | 'planned' | 'none';

const TONE_CLASS: Record<Tone, string> = {
  crit: 'border-l-destructive bg-destructive/5 text-foreground',
  planned: 'border-l-steel bg-steel/5 text-foreground',
  none: 'border-l-border bg-muted/30 text-fg-muted',
};

const TONE_CHIP: Record<Tone, { label: string; className: string }> = {
  crit: {
    label: 'ORDER NOW',
    className: 'border-destructive/40 bg-destructive/10 text-destructive',
  },
  planned: { label: 'PLANNED', className: 'border-steel/40 bg-steel/10 text-steel' },
  none: { label: 'OK', className: 'border-border text-fg-muted' },
};

/**
 * Cluster detail recommendation banner (spec §5.2): a verb-first,
 * always-rendered line (never omitted — screen readers get a consistent
 * structure whether or not a breach is projected) derived from
 * `deriveProcurementKpi`'s status. Its "crit" tone deliberately covers BOTH
 * overdue and the ≤28-day urgent window (the KPI strip's own "Order by" tile
 * keeps the finer-grained warn/crit split; this banner is a call-to-action
 * and treats both as equally urgent, matching the rail/tile "ORDER NOW" tag).
 */
export function RecommendationBanner({
  procurement,
  today = new Date(),
}: RecommendationBannerProps): React.JSX.Element {
  const kpi = deriveProcurementKpi(procurement, today);
  const { orderByDate, leadTimeWeeks } = procurement;
  const leadPhrase = `${leadTimeWeeks}-wk lead`;

  let tone: Tone;
  let message: string;

  if (kpi.status === 'ok' && orderByDate === null) {
    tone = 'none';
    message = 'No order needed in this forecast window.';
  } else if (orderByDate === null) {
    // MINOR fix (review round 1): deriveProcurementKpi never actually
    // returns crit/warn without an orderByDate, but ProcurementKpiStatus's
    // type allows it — if that invariant is ever violated, surface the
    // urgency instead of silently masking it behind the no-breach copy
    // (which would tell the reader "no order needed" when the derived
    // status says otherwise).
    tone = 'crit';
    message = `Order now — order date unavailable — check forecast · ${leadPhrase}`;
  } else if (kpi.status === 'crit') {
    const days = Math.abs(daysUntil(orderByDate, today));
    message = `Order now — last safe order date ${orderByDate} (${days} day${days === 1 ? '' : 's'} overdue) · ${leadPhrase}`;
    tone = 'crit';
  } else if (kpi.status === 'warn') {
    const days = daysUntil(orderByDate, today);
    message = `Order now — last safe order date ${orderByDate} (in ${days} d) · ${leadPhrase}`;
    tone = 'crit';
  } else {
    message = `Order by ${orderByDate} (${formatRelativeDays(orderByDate, today)}) · ${leadPhrase}`;
    tone = 'planned';
  }

  const chip = TONE_CHIP[tone];

  return (
    <div
      data-testid="recommendation-banner"
      data-tone={tone}
      className={cn(
        'flex items-center gap-2.5 rounded-r-[var(--radius)] border-l-[3px] px-3.5 py-2.5 text-[12.5px] font-medium leading-[1.5]',
        TONE_CLASS[tone],
      )}
    >
      <span
        className={cn(
          'inline-flex shrink-0 items-center rounded border px-1.5 py-0.5 font-mono text-[9.5px] font-bold tracking-[0.08em]',
          chip.className,
        )}
      >
        {chip.label}
      </span>
      <span>{message}</span>
    </div>
  );
}
