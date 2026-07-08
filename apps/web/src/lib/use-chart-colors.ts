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
  /**
   * Categories are now free-form strings (display names). `eventNamed` holds the
   * recognizable colors for the well-known display names; anything else is
   * resolved deterministically against `eventPalette` via {@link eventColor}.
   */
  eventNamed: Record<string, string>;
  eventPalette: string[];
}

/**
 * @ai-note The chart palette lives in `styles.css` as `--chart-*` custom
 * properties (semantic roles reference the shared tokens; `--chart-1..7` is the
 * chart-only categorical event scale). {@link useChartColors} reads those at
 * runtime so charts track the design tokens in both themes.
 *
 * These maps are the resolved fallback for environments where the stylesheet
 * is not applied to the document — jsdom unit tests, and the first render
 * before styles resolve. They mirror the resolved token values; in the browser
 * the real `--chart-*` properties win.
 */
type Palette7 = readonly [string, string, string, string, string, string, string];

interface ChartFallback {
  consumption: string;
  capacity: string;
  grid: string;
  axis: string;
  utilizationOk: string;
  utilizationWarn: string;
  utilizationCrit: string;
  palette: Palette7;
}

const FALLBACK_LIGHT: ChartFallback = {
  consumption: '#a16207', // --accent
  capacity: '#b91c1c', // --destructive
  grid: '#e7e5e4', // --border-strong
  axis: '#78716c', // --fg-subtle
  utilizationOk: '#57534e', // --fg-muted
  utilizationWarn: '#92400e', // --warning
  utilizationCrit: '#b91c1c', // --destructive
  palette: ['#171717', '#525252', '#737373', '#a3a3a3', '#a16207', '#92400e', '#0f766e'],
};

const FALLBACK_DARK: ChartFallback = {
  consumption: '#fbbf24', // --accent
  capacity: '#f87171', // --destructive
  grid: '#3a3633', // --border-strong
  axis: '#8a8580', // --fg-subtle
  utilizationOk: '#a8a29e', // --fg-muted
  utilizationWarn: '#f59e0b', // --warning
  utilizationCrit: '#f87171', // --destructive
  palette: ['#e5e5e5', '#a3a3a3', '#737373', '#525252', '#fbbf24', '#f59e0b', '#2dd4bf'],
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
  const c1 = read('--chart-1', fb.palette[0]);
  const c2 = read('--chart-2', fb.palette[1]);
  const c3 = read('--chart-3', fb.palette[2]);
  const c4 = read('--chart-4', fb.palette[3]);
  const c5 = read('--chart-5', fb.palette[4]);
  const c6 = read('--chart-6', fb.palette[5]);
  const c7 = read('--chart-7', fb.palette[6]);

  return {
    consumption,
    consumptionFill: toRgba(consumption, isDark ? 0.15 : 0.1),
    capacity: read('--chart-capacity', fb.capacity),
    grid: read('--chart-grid', fb.grid),
    axis: read('--chart-axis', fb.axis),
    utilizationOk: read('--chart-utilization-ok', fb.utilizationOk),
    utilizationWarn: read('--chart-utilization-warn', fb.utilizationWarn),
    utilizationCrit: read('--chart-utilization-crit', fb.utilizationCrit),
    // The four well-known categories map to the first four scale entries, matching
    // the deterministic fallback in eventColor for any other category.
    eventNamed: { Growth: c1, Hardware: c2, OpenShift: c3, Note: c4 },
    eventPalette: [c1, c2, c3, c4, c5, c6, c7],
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

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

/**
 * Resolve any free-form category string to a stable chart color: a recognizable
 * color for the well-known display names, otherwise a deterministic pick from
 * the palette (so the same category always gets the same color).
 */
export function eventColor(colors: ChartColors, category: string): string {
  const named = colors.eventNamed[category];
  if (named) return named;
  const palette = colors.eventPalette;
  return palette[hashString(category) % palette.length] ?? palette[0] ?? colors.axis;
}
