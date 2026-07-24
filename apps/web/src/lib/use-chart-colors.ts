import { useEffect, useState } from 'react';

import { useTheme } from '@/components/theme/use-theme';

export interface ChartColors {
  consumption: string;
  consumptionFill: string;
  capacity: string;
  grid: string;
  axis: string;
  utilizationOk: string;
  utilizationWarn: string;
  utilizationCrit: string;
  /** Event marker color when the event adds capacity (`capacityDelta > 0`). */
  eventAdds: string;
  /** Event marker color for everything else — see {@link eventColor}. */
  eventConsumes: string;
  /** Empirical uncertainty-band base (neutral); rendered translucent. */
  band: string;
}

/**
 * @ai-note The chart palette lives in `styles.css` as `--chart-*` custom
 * properties (semantic roles reference the shared `--success`/`--destructive`/
 * etc tokens). {@link useChartColors} reads those at runtime so charts track
 * the design tokens in both themes.
 *
 * These maps are the resolved fallback for environments where the stylesheet
 * is not applied to the document — jsdom unit tests, and the first render
 * before styles resolve. They mirror the resolved token values; in the browser
 * the real `--chart-*` properties win.
 */
export interface ChartFallback {
  consumption: string;
  capacity: string;
  grid: string;
  axis: string;
  utilizationOk: string;
  utilizationWarn: string;
  utilizationCrit: string;
  eventAdds: string;
  eventConsumes: string;
  band: string;
}

export const FALLBACK_LIGHT: ChartFallback = {
  consumption: '#7c3aed', // --chart-consumption (dedicated violet, not --accent)
  capacity: '#3a455e', // --chart-capacity
  grid: '#e3e8f2', // --chart-grid
  axis: '#8a94ac', // --chart-axis
  utilizationOk: '#5a6478', // --fg-muted
  utilizationWarn: '#865c0c', // --warning
  utilizationCrit: '#c0343c', // --destructive
  eventAdds: '#176b45', // --success
  eventConsumes: '#c0343c', // --destructive
  band: '#6b7488', // --chart-band (neutral)
};

export const FALLBACK_DARK: ChartFallback = {
  consumption: '#c084fc', // --chart-consumption (dedicated violet, not --accent)
  capacity: '#c7d0e4', // --chart-capacity
  grid: '#1b2236', // --chart-grid
  axis: '#2a3450', // --chart-axis
  utilizationOk: '#8b93a7', // --fg-muted
  utilizationWarn: '#ffc53d', // --warning
  utilizationCrit: '#ff6b6b', // --destructive
  eventAdds: '#3dd68c', // --success
  eventConsumes: '#ff6b6b', // --destructive
  band: '#8b93a7', // --chart-band (neutral)
};

/**
 * Convert a resolved token color (hex or `rgb()`) to an `rgba()` string at the
 * given alpha, for the translucent area fill under the consumption line. Returns
 * the input untouched if it is neither form.
 */
function toRgba(color: string, alpha: number): string {
  const value = color.trim();
  const hexMatch = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  if (hexMatch?.[1]) {
    const h = hexMatch[1];
    const full = h.length === 3 ? h.replace(/./g, (c) => c + c) : h;
    const r = parseInt(full.slice(0, 2), 16);
    const g = parseInt(full.slice(2, 4), 16);
    const b = parseInt(full.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  const rgbMatch = /^rgba?\(([^)]+)\)$/i.exec(value);
  if (rgbMatch?.[1]) {
    const parts = rgbMatch[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length >= 3) return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${alpha})`;
  }
  return value;
}

function resolveChartColors(isDark: boolean): ChartColors {
  const fb = isDark ? FALLBACK_DARK : FALLBACK_LIGHT;
  const styles =
    typeof document === 'undefined' ? null : getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string): string => {
    if (!styles) return fallback;
    const value = styles.getPropertyValue(name).trim();
    return value.length > 0 ? value : fallback;
  };

  const consumption = read('--chart-consumption', fb.consumption);

  return {
    consumption,
    consumptionFill: toRgba(consumption, isDark ? 0.15 : 0.1),
    capacity: read('--chart-capacity', fb.capacity),
    grid: read('--chart-grid', fb.grid),
    axis: read('--chart-axis', fb.axis),
    utilizationOk: read('--chart-utilization-ok', fb.utilizationOk),
    utilizationWarn: read('--chart-utilization-warn', fb.utilizationWarn),
    utilizationCrit: read('--chart-utilization-crit', fb.utilizationCrit),
    eventAdds: read('--chart-event-adds', fb.eventAdds),
    eventConsumes: read('--chart-event-consumes', fb.eventConsumes),
    band: read('--chart-band', fb.band),
  };
}

export function useChartColors(): ChartColors {
  const { resolvedTheme } = useTheme();
  const [colors, setColors] = useState<ChartColors>(() =>
    resolveChartColors(resolvedTheme === 'dark'),
  );

  useEffect(() => {
    // Re-read the resolved --chart-* properties from the live DOM. A
    // MutationObserver on <html>'s class (rather than reading in this effect
    // directly) sidesteps the effect-ordering race with ThemeProvider, which
    // toggles the `dark` class in its own ancestor effect that runs after this
    // one — so reading here on a theme flip would otherwise see the stale class.
    const sync = (): void =>
      setColors(resolveChartColors(document.documentElement.classList.contains('dark')));
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  return colors;
}

/**
 * Resolve an event's `capacityDelta` to its marker color: green when the event
 * adds capacity, red for everything else (reduces capacity, null/undefined, or
 * a consumption-only event) — see issue #286.
 */
export function eventColor(colors: ChartColors, capacityDelta: number | null | undefined): string {
  return (capacityDelta ?? 0) > 0 ? colors.eventAdds : colors.eventConsumes;
}
