import { daysUntil } from '@/lib/dates';
import { formatDateShort } from '@/lib/format-month';
import { cn } from '@/lib/utils';

export interface OrderByRailItem {
  clusterId: string;
  name: string;
  /** Full `YYYY-MM-DD` last-safe-order date. */
  orderByDate: string;
  leadTimeWeeks: number;
}

interface OrderByRailProps {
  items: OrderByRailItem[];
  /** Highlights the tick for this cluster (tile hover/focus links back to the rail). */
  linkedId?: string;
  /** Fired with the cluster id on tick hover/focus, and `null` on leave/blur. */
  onTickHover?: (id: string | null) => void;
}

/** Matches `deriveProcurementKpi`'s URGENT_DAYS — keeps rail/tile/KPI urgency language consistent. */
const URGENT_DAYS = 28;
const SOON_DAYS = 90;
/** The rail always spans the next 12 months (spec §4.2). */
const RAIL_WINDOW_DAYS = 365;

export type OrderByUrgencyTone = 'now' | 'soon' | 'planned' | 'none';

/**
 * Classifies an order-by date's urgency. Thresholds match `deriveProcurementKpi`
 * (URGENT_DAYS = 28): "now" covers overdue dates too (days <= 28, including negative).
 */
export function orderByUrgency(
  orderByDate: string | null,
  today: Date = new Date(),
): OrderByUrgencyTone {
  if (orderByDate === null) return 'none';
  const days = daysUntil(orderByDate, today);
  if (days <= URGENT_DAYS) return 'now';
  if (days <= SOON_DAYS) return 'soon';
  return 'planned';
}

/** `'in 5 d'` / `'in 13 wk'` / `'in 5 mo'` / `'12 d overdue'`. */
export function formatRelativeDays(dateStr: string, today: Date = new Date()): string {
  const days = daysUntil(dateStr, today);
  if (days < 0) return `${Math.abs(days)} d overdue`;
  if (days < 70) return `in ${days} d`;
  if (days < 126) return `in ${Math.round(days / 7)} wk`;
  return `in ${Math.round(days / 30.44)} mo`;
}

const URGENCY_STYLE: Record<
  Exclude<OrderByUrgencyTone, 'none'>,
  { tag: string; className: string }
> = {
  now: { tag: 'ORDER NOW', className: 'text-destructive' },
  soon: { tag: 'ORDER SOON', className: 'text-warning' },
  planned: { tag: 'PLANNED', className: 'text-fg-muted' },
};

/**
 * Order-by rail (spec §4.2): a full-width 12-month strip with one tick per
 * cluster that has a non-null procurement order-by date. A labelled zone shades
 * the configured procurement lead time from NOW; hovering/focusing a tick links
 * back to its tile via `onTickHover` + `data-cluster-id`.
 */
export function OrderByRail({ items, linkedId, onTickHover }: OrderByRailProps): React.JSX.Element {
  const today = new Date();

  const ticks = items
    .map((item) => {
      const days = daysUntil(item.orderByDate, today);
      const pct = Math.max(0, Math.min(100, (days / RAIL_WINDOW_DAYS) * 100));
      const urgency = orderByUrgency(item.orderByDate, today);
      return { ...item, days, pct, urgency };
    })
    .sort((a, b) => a.days - b.days);

  // The zone measures the configured procurement lead time forward from NOW, so
  // it is drawn whenever the rail has ticks at all. An overdue order-by is
  // exactly when "anything ordered today lands after this window" matters most
  // — the old `days >= 0` guard hid the zone in precisely that case.
  const earliest = ticks[0];
  const leadDays = earliest ? earliest.leadTimeWeeks * 7 : 0;
  const leadZonePct = Math.min(100, (leadDays / RAIL_WINDOW_DAYS) * 100);
  const showLeadZone = leadDays > 0;

  // The zone and its label are decorative; this hint is where the meaning
  // reaches assistive tech, so it carries the lead time in words. Only
  // reachable when the rail has ticks — the empty state has its own copy
  // (below), since there is no zone or tick to describe yet.
  // Both of these feed the populated branch only — the compact empty state
  // renders neither the header-row hint nor the month axis — so the healthy
  // fleet console (the common case this compaction exists for) shouldn't pay
  // for 12 Date constructions and 12 Intl format calls it then discards.
  const populated = ticks.length > 0;

  const hint = showLeadZone
    ? `shaded = inside ${leadDays}-day lead time · tick = last safe order date`
    : 'tick = last safe order date';

  const monthTicks = populated
    ? Array.from({ length: 12 }, (_, i) => {
        const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + i + 1, 1));
        const pct = (daysUntil(d.toISOString().slice(0, 10), today) / RAIL_WINDOW_DAYS) * 100;
        return {
          key: d.toISOString().slice(0, 7),
          label: d.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }).toUpperCase(),
          pct,
        };
      })
    : [];

  const heading = (
    <h2 className="text-[10px] font-semibold uppercase tracking-[0.16em] text-fg-muted">
      Order deadlines — next 12 months
    </h2>
  );

  return (
    <section
      className="rounded-[var(--radius-card)] border border-border p-4"
      style={{ background: 'var(--surface-card)' }}
      aria-label="Order deadlines: procurement timeline for the next 12 months"
    >
      {ticks.length === 0 ? (
        // Compact single-row strip: no order-bys means nothing for the
        // 86px tick area or month axis to plot, so both are hidden rather
        // than restating the all-clear verdict a second time below it.
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          {heading}
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span
              aria-hidden
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-success/50 text-success"
            >
              ✓
            </span>
            <span className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-fg-muted">
              No order-by dates in the next 12 months
            </span>
            {/* 10px, not the 9px the populated hint still uses: this span is
                new copy, and the design system's own --text-label floor is
                10px (#243 Part B micro-text finding). */}
            <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-fg-subtle">
              · each mark = a cluster's last safe order date
            </span>
          </span>
        </div>
      ) : (
        <>
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-3">
            {heading}
            <span className="text-[9px] font-semibold uppercase tracking-[0.1em] text-fg-subtle">
              {hint}
            </span>
          </div>

          <div className="relative h-[86px] border-b border-border-strong">
            {showLeadZone ? (
              <span
                aria-hidden
                data-testid="rail-lead-zone"
                className="absolute inset-y-0 left-0 border-r border-dashed border-accent/45"
                style={{
                  width: `${leadZonePct}%`,
                  background:
                    'linear-gradient(90deg, color-mix(in oklab, var(--accent) 9%, transparent), color-mix(in oklab, var(--accent) 3%, transparent))',
                }}
              />
            ) : null}
            {monthTicks.map((m) => (
              <span
                key={m.key}
                aria-hidden
                className="absolute top-4 bottom-0 w-px"
                style={{ left: `${m.pct}%`, background: 'var(--chart-grid)' }}
              />
            ))}
            {/* After the gridlines: the zone is a backdrop, but its label is
                text and must not be crossed by a month rule. */}
            {showLeadZone ? (
              <span
                aria-hidden
                className="absolute bottom-[3px] -translate-x-full whitespace-nowrap pr-1.5 font-mono text-[9px] font-semibold tracking-[0.1em]"
                style={{ left: `${leadZonePct}%`, color: 'var(--accent-label)' }}
              >
                LEAD {leadDays} D
              </span>
            ) : null}
            <span
              aria-hidden
              className="absolute inset-y-0 left-0 w-0.5 bg-steel"
              style={{ boxShadow: '0 0 8px color-mix(in oklab, var(--steel) 50%, transparent)' }}
            />
            <span className="absolute -top-px left-2 whitespace-nowrap text-[9.5px] font-semibold uppercase tracking-[0.1em] text-steel">
              NOW
            </span>
            {ticks.map((tick) => {
              const style = URGENCY_STYLE[tick.urgency === 'none' ? 'planned' : tick.urgency];
              const linked = linkedId === tick.clusterId;
              return (
                <button
                  key={tick.clusterId}
                  type="button"
                  data-cluster-id={tick.clusterId}
                  {...(linked ? { 'data-linked': 'true' } : {})}
                  onMouseEnter={() => onTickHover?.(tick.clusterId)}
                  onMouseLeave={() => onTickHover?.(null)}
                  onFocus={() => onTickHover?.(tick.clusterId)}
                  onBlur={() => onTickHover?.(null)}
                  className={cn(
                    'group absolute bottom-0 flex min-h-6 min-w-6 -translate-x-1/2 flex-col items-center justify-end rounded',
                    style.className,
                  )}
                  style={{ left: `${tick.pct}%` }}
                  aria-label={`${tick.name}: ${style.tag.toLowerCase()} ${tick.orderByDate} (${formatRelativeDays(tick.orderByDate, today)}). Open cluster detail.`}
                >
                  <span
                    className={cn(
                      'mb-1 flex flex-col items-start gap-0.5 whitespace-nowrap rounded bg-popover/95 px-1 py-0.5 text-left opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100',
                      linked && 'opacity-100',
                    )}
                  >
                    <span className="font-mono text-[10.5px] font-semibold text-foreground">
                      {tick.name}
                    </span>
                    <span className="flex items-baseline gap-1.5 font-mono text-[9.5px]">
                      <span className="text-foreground/85">
                        {formatDateShort(tick.orderByDate)}
                      </span>
                      <span className="font-bold tracking-[0.08em]">{style.tag}</span>
                    </span>
                  </span>
                  <span
                    aria-hidden
                    className={cn(
                      'h-2 w-2 rounded-full bg-current transition-transform',
                      linked && 'scale-150',
                    )}
                    style={linked ? { boxShadow: '0 0 12px currentColor' } : undefined}
                  />
                </button>
              );
            })}
          </div>
          <div className="relative mt-1 h-4">
            {monthTicks.map((m) => (
              <span
                key={m.key}
                data-testid="rail-month-label"
                className="absolute translate-x-1 font-mono text-[9px] font-medium tracking-[0.08em] text-fg-subtle"
                style={{ left: `${m.pct}%` }}
              >
                {m.label}
              </span>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
