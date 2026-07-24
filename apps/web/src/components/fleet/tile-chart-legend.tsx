import { useChartColors } from '@/lib/use-chart-colors';

/**
 * Compact key for the per-tile forecast charts (critique fix): a sighted user
 * shouldn't have to decode dash pattern + hue to tell the usage, forecast,
 * threshold, capacity, and order-by lines apart on a 168px chart. `aria-hidden`
 * — the charts carry their own accessible descriptions, so this is a visual aid
 * only. Colours come from the same `useChartColors` the charts read, so the key
 * can never drift from the marks it explains.
 */
export function TileChartLegend(): React.JSX.Element {
  const colors = useChartColors();
  const items: Array<{ label: string; color: string; dashed: boolean }> = [
    { label: 'Usage', color: colors.consumption, dashed: false },
    { label: 'Forecast', color: colors.consumption, dashed: true },
    { label: 'Warn', color: colors.utilizationWarn, dashed: true },
    { label: 'Crit', color: colors.utilizationCrit, dashed: true },
    { label: 'Capacity', color: colors.capacity, dashed: true },
    { label: 'Order-by', color: 'var(--steel)', dashed: true },
  ];
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1.5" aria-hidden>
      <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-fg-subtle">
        Chart key
      </span>
      {items.map((it) => (
        <span key={it.label} className="flex items-center gap-1.5 text-[11px] text-fg-muted">
          <span
            className="inline-block h-0 w-4 shrink-0"
            style={{ borderTop: `2px ${it.dashed ? 'dashed' : 'solid'} ${it.color}` }}
          />
          {it.label}
        </span>
      ))}
    </div>
  );
}
