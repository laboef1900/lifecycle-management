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

const DAY_MS = 24 * 60 * 60 * 1000;
/** Matches `deriveProcurementKpi`'s URGENT_DAYS — keeps rail/tile/KPI urgency language consistent. */
const URGENT_DAYS = 28;
const SOON_DAYS = 90;
/** The rail always spans the next 12 months (spec §4.2). */
const RAIL_WINDOW_DAYS = 365;

/** Days from `today` (UTC midnight) until `dateStr` (also UTC midnight). Negative if past. */
function daysUntil(dateStr: string, today: Date): number {
  const target = new Date(`${dateStr}T00:00:00Z`).getTime();
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.round((target - todayUtc) / DAY_MS);
}

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
 * cluster that has a non-null procurement order-by date. The earliest tick
 * carries a shaded zone spanning its cluster's lead time; hovering/focusing a
 * tick links back to its tile via `onTickHover` + `data-cluster-id`.
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

  const earliest = ticks[0];
  const leadZonePct =
    earliest && earliest.days >= 0
      ? Math.min(100, ((earliest.leadTimeWeeks * 7) / RAIL_WINDOW_DAYS) * 100)
      : 0;

  const monthTicks = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + i + 1, 1));
    const pct = (daysUntil(d.toISOString().slice(0, 10), today) / RAIL_WINDOW_DAYS) * 100;
    return {
      key: d.toISOString().slice(0, 7),
      label: d.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }).toUpperCase(),
      pct,
    };
  });

  return (
    <section
      className="rounded-[var(--radius-card)] border border-border p-4"
      style={{ background: 'var(--surface-card)' }}
      aria-label="Order-by rail: procurement timeline for the next 12 months"
    >
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-[10px] font-semibold uppercase tracking-[0.16em] text-fg-muted">
          Order-by rail — next 12 months
        </h2>
        <span className="text-[9px] font-semibold uppercase tracking-[0.1em] text-fg-subtle">
          {ticks.length > 0
            ? 'shaded = inside lead time · tick = last safe order date'
            : 'the lead-time zone appears when an order-by falls inside 90 days'}
        </span>
      </div>

      <div className="relative h-[86px] border-b border-border-strong">
        {ticks.length === 0 ? (
          <div className="absolute inset-0 flex items-center justify-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-fg-muted">
            <span
              aria-hidden
              className="flex h-5 w-5 items-center justify-center rounded-full border border-success/50 text-success"
            >
              ✓
            </span>
            No order-by dates in the next 12 months
          </div>
        ) : (
          <>
            {leadZonePct > 0 ? (
              <span
                aria-hidden
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
          </>
        )}
      </div>
      <div className="relative mt-1 h-4">
        {monthTicks.map((m) => (
          <span
            key={m.key}
            className="absolute translate-x-1 font-mono text-[9px] font-medium tracking-[0.08em] text-fg-subtle"
            style={{ left: `${m.pct}%` }}
          >
            {m.label}
          </span>
        ))}
      </div>
    </section>
  );
}
