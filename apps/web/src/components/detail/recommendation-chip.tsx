import type { ProcurementInfo } from '@lcm/shared';
import { CalendarClock, Check, CircleHelp, TriangleAlert } from 'lucide-react';
import * as React from 'react';

import { formatRelativeDays } from '@/components/fleet/order-by-rail';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { HOSTS_TAB_HASH, requestAnchorFocus } from '@/lib/anchors';
import { daysUntil } from '@/lib/dates';
import { formatDateShort } from '@/lib/format-month';
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
    // Names the fix location, not just the problem (#243 Part B item 4) — the
    // Hosts tab is the only place capacity can be added, and vSphere sync
    // writes no host capacity (#198), so this is the normal first-run state
    // for a synced cluster on the surface that drives purchasing. Phrasing
    // ("add host capacity to calculate …") matches cluster-tile.tsx's own
    // unknown-capacity verdict/aria-label, so the two surfaces read as one
    // voice rather than two dialects for the same gap.
    message = 'Capacity unknown — add host capacity on the Hosts tab to calculate runway.';
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
    // `daysUntil`/`formatRelativeDays` still take the raw ISO string (their
    // math needs it); only the human-facing text below routes through
    // `formatDateShort` (#243 Part B copy item 1 — no more raw ISO dates in
    // chips/banners next to formatted dates everywhere else).
    const orderByLabel = formatDateShort(orderByDate);
    tone = 'crit';
    shortText = `Order now — ${days}d overdue`;
    message = `Order now — last safe order date ${orderByLabel} (${days} day${days === 1 ? '' : 's'} overdue) · ${leadPhrase}`;
  } else if (kpi.status === 'warn') {
    const days = daysUntil(orderByDate, today);
    const orderByLabel = formatDateShort(orderByDate);
    tone = 'crit';
    shortText = `Order now — by ${orderByLabel}`;
    message = `Order now — last safe order date ${orderByLabel} (in ${days} d) · ${leadPhrase}`;
  } else {
    const orderByLabel = formatDateShort(orderByDate);
    tone = 'planned';
    shortText = `Order by ${orderByLabel}`;
    message = `Order by ${orderByLabel} (${formatRelativeDays(orderByDate, today)}) · ${leadPhrase}`;
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
  const triggerClassName = cn(
    'inline-flex items-center gap-1.5 rounded-sm border px-1.5 py-1 font-mono text-[9.5px] font-bold tracking-[0.08em]',
    TONE_CHIP[rec.tone].className,
  );
  const chipContent = (
    <>
      <Icon className="h-3 w-3 shrink-0" aria-hidden />
      {rec.chipLabel}
      <span className="font-sans text-[11px] font-medium normal-case tracking-normal">
        {rec.shortText}
      </span>
    </>
  );

  // Unknown is the one tone with a fix to offer (#243 Part B item 4), so it
  // alone gets the interactive trigger below; every other tone keeps the
  // original non-interactive span this file's docs already explain.
  if (rec.tone === 'unknown') {
    return (
      <span role="status" data-testid="recommendation-chip" data-tone={rec.tone}>
        <UnknownCapacityTrigger className={triggerClassName} message={rec.message}>
          {chipContent}
        </UnknownCapacityTrigger>
      </span>
    );
  }

  return (
    <span role="status" data-testid="recommendation-chip" data-tone={rec.tone}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span data-testid="recommendation-chip-trigger" className={triggerClassName}>
            {chipContent}
            <span className="sr-only">{rec.message}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">{rec.message}</TooltipContent>
      </Tooltip>
    </span>
  );
}

/**
 * Unknown-capacity chip trigger (#243 Part B item 4). Unlike every other
 * tone's non-interactive span above, this one has an action to offer —
 * record capacity on the Hosts tab — so it is a real, focusable `<button>`
 * whose click jumps the panel to its Hosts tab via the shared anchor-focus
 * mechanism (`src/lib/anchors.ts`).
 *
 * The tooltip is forced HOVER-ONLY here, the same fix `BackLink` applies to
 * its own tooltip (`ui/back-link.tsx`) and for the same reason: Radix's
 * uncontrolled `Trigger` opens on focus as well as hover, and a focus-opened
 * tooltip dismisses itself on Escape and marks the event consumed — which the
 * panel's Esc-chain guard respects, silently costing a keyboard user a second
 * press to close the panel. Every other tone's trigger is a non-focusable
 * span that could never trip this, which is why only this one needs the
 * controlled gating.
 */
function UnknownCapacityTrigger({
  className,
  message,
  children,
}: {
  className: string;
  message: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const [tooltipOpen, setTooltipOpen] = React.useState(false);
  const hoverRef = React.useRef(false);
  return (
    <Tooltip
      open={tooltipOpen}
      onOpenChange={(next) => {
        // Radix requests open for both hover and focus; admit hover only
        // (closes are always honored).
        if (!next || hoverRef.current) setTooltipOpen(next);
      }}
    >
      <TooltipTrigger asChild>
        <button
          type="button"
          data-testid="recommendation-chip-trigger"
          className={className}
          onClick={() => requestAnchorFocus(HOSTS_TAB_HASH)}
          onPointerEnter={() => {
            hoverRef.current = true;
          }}
          onPointerLeave={() => {
            hoverRef.current = false;
          }}
        >
          {children}
          <span className="sr-only">{message} Go to the Hosts tab.</span>
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{message}</TooltipContent>
    </Tooltip>
  );
}
