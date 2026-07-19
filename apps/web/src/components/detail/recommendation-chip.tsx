import type { ProcurementInfo } from '@lcm/shared';
import { CalendarClock, Check, CircleHelp, TriangleAlert } from 'lucide-react';
import * as React from 'react';

import { formatRelativeDays } from '@/components/fleet/order-by-rail';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { daysUntil } from '@/lib/dates';
import { deriveProcurementKpi } from '@/lib/procurement-kpi';
import { cn } from '@/lib/utils';

export interface RecommendationChipProps {
  procurement: ProcurementInfo;
  today?: Date;
  /** False when the current forecast has no capacity denominator. */
  capacityKnown?: boolean;
}

export type RecommendationTone = 'crit' | 'planned' | 'none' | 'unknown';

export interface RecommendationInfo {
  tone: RecommendationTone;
  /** Mono status label: ORDER NOW / PLANNED / OK / UNKNOWN. */
  chipLabel: string;
  /** Verb-first compact text carried visibly on the chip. */
  shortText: string;
  /** Full guidance sentence — tooltip + sr-only body of the chip. */
  message: string;
}

const TONE_CHIP: Record<RecommendationTone, { label: string; className: string }> = {
  crit: {
    label: 'ORDER NOW',
    className: 'border-destructive/40 bg-destructive/10 text-destructive',
  },
  planned: { label: 'PLANNED', className: 'border-steel/40 bg-steel/10 text-steel' },
  none: { label: 'OK', className: 'border-border text-fg-muted' },
  unknown: { label: 'UNKNOWN', className: 'border-border-strong text-fg-muted' },
};

/** Icon per tone — the house rule (and WCAG 1.4.1): never color alone. */
const TONE_ICON: Record<RecommendationTone, typeof TriangleAlert> = {
  crit: TriangleAlert,
  planned: CalendarClock,
  none: Check,
  unknown: CircleHelp,
};

/**
 * Procurement recommendation (spec §5.2, reshaped by #243): a verb-first,
 * always-derived line (screen readers get a consistent structure whether or
 * not a breach is projected) computed from `deriveProcurementKpi`'s status.
 * The "crit" tone deliberately covers BOTH overdue and the ≤28-day urgent
 * window (the KPI strip's own "Order by" tile keeps the finer-grained
 * warn/crit split; this recommendation is a call-to-action and treats both as
 * equally urgent, matching the rail/tile "ORDER NOW" tag).
 */
export function deriveRecommendation(
  procurement: ProcurementInfo,
  today: Date = new Date(),
  capacityKnown = true,
): RecommendationInfo {
  const kpi = deriveProcurementKpi(procurement, today, capacityKnown);
  const { orderByDate, leadTimeWeeks } = procurement;
  const leadPhrase = `${leadTimeWeeks}-wk lead`;

  let tone: RecommendationTone;
  let shortText: string;
  let message: string;

  if (kpi.status === 'unknown') {
    tone = 'unknown';
    shortText = 'Capacity unknown';
    message = 'Capacity unknown — record capacity before relying on procurement timing.';
  } else if (kpi.status === 'ok' && orderByDate === null) {
    tone = 'none';
    shortText = 'No order needed';
    message = 'No order needed in this forecast window.';
  } else if (orderByDate === null) {
    // deriveProcurementKpi never actually returns crit/warn without an
    // orderByDate, but ProcurementKpiStatus's type allows it — if that
    // invariant is ever violated, surface the urgency instead of silently
    // masking it behind the no-breach copy.
    tone = 'crit';
    shortText = 'Order now — check forecast';
    message = `Order now — order date unavailable — check forecast · ${leadPhrase}`;
  } else if (kpi.status === 'crit') {
    const days = Math.abs(daysUntil(orderByDate, today));
    tone = 'crit';
    shortText = `Order now — ${days}d overdue`;
    message = `Order now — last safe order date ${orderByDate} (${days} day${days === 1 ? '' : 's'} overdue) · ${leadPhrase}`;
  } else if (kpi.status === 'warn') {
    const days = daysUntil(orderByDate, today);
    tone = 'crit';
    shortText = `Order now — by ${orderByDate}`;
    message = `Order now — last safe order date ${orderByDate} (in ${days} d) · ${leadPhrase}`;
  } else {
    tone = 'planned';
    shortText = `Order by ${orderByDate}`;
    message = `Order by ${orderByDate} (${formatRelativeDays(orderByDate, today)}) · ${leadPhrase}`;
  }

  return { tone, chipLabel: TONE_CHIP[tone].label, shortText, message };
}

/**
 * Compact recommendation chip for the cluster panel's title row (#243 item 4
 * — replaces the full-width `RecommendationBanner`; proximity binds status to
 * the entity it describes, like GitHub's "Archived" badge beside the repo
 * name). Icon + mono tone label + verb-first short text; the full guidance
 * sentence rides along sr-only (so the status region carries everything
 * without interaction) and in a hover-only tooltip for sighted pointer users.
 *
 * `role="status"` sits on the wrapper, not the trigger, so tone/text changes
 * (a scenario flipping the forecast) are announced politely. Chip text keeps
 * the same tone-on-tint pairings the banner used (AA-checked per theme in
 * spec §3).
 *
 * The trigger is a NON-INTERACTIVE `<span>`, deliberately not a button (#243
 * review): it has no action, so a focusable button here was a dead tab stop
 * inside the panel's tab trap that announced itself as operable (WCAG 4.1.2
 * role fidelity) and read as tappable on touch, where Radix tooltips never
 * open. Nothing is lost: AT reads the full sentence from the status region's
 * content, and sighted keyboard users see the verb-first short text. The
 * non-focusable trigger also makes the tooltip structurally HOVER-ONLY —
 * Radix's focus-open path can never fire — which `BackLink` needs controlled
 * state to achieve (it must stay focusable; a focus-opened tooltip would
 * swallow the panel's first Escape via the consumed-event guard).
 */
export function RecommendationChip({
  procurement,
  today = new Date(),
  capacityKnown = true,
}: RecommendationChipProps): React.JSX.Element {
  const rec = deriveRecommendation(procurement, today, capacityKnown);
  const Icon = TONE_ICON[rec.tone];
  return (
    <span role="status" data-testid="recommendation-chip" data-tone={rec.tone}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            data-testid="recommendation-chip-trigger"
            className={cn(
              'inline-flex items-center gap-1.5 rounded-sm border px-1.5 py-1 font-mono text-[9.5px] font-bold tracking-[0.08em]',
              TONE_CHIP[rec.tone].className,
            )}
          >
            <Icon className="h-3 w-3 shrink-0" aria-hidden />
            {rec.chipLabel}
            <span className="font-sans text-[11px] font-medium normal-case tracking-normal">
              {rec.shortText}
            </span>
            <span className="sr-only">{rec.message}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">{rec.message}</TooltipContent>
      </Tooltip>
    </span>
  );
}
