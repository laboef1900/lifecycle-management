import { useMemo } from 'react';

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

// Honey is the focused/consumption color.
const LIGHT: ChartColors = {
  consumption: '#8a6016',
  consumptionFill: 'rgba(138, 96, 22, 0.10)',
  capacity: '#b91c1c',
  grid: '#e5e5e5',
  axis: '#737373',
  utilizationOk: '#525252',
  utilizationWarn: '#b45309',
  utilizationCrit: '#b91c1c',
  eventNamed: {
    Growth: '#171717',
    Hardware: '#525252',
    OpenShift: '#737373',
    Note: '#a3a3a3',
  },
  eventPalette: ['#171717', '#525252', '#737373', '#a3a3a3', '#8a6016', '#b45309', '#0f766e'],
};

const DARK: ChartColors = {
  consumption: '#f9c74f',
  consumptionFill: 'rgba(249, 199, 79, 0.15)',
  capacity: '#f87171',
  grid: '#333333',
  axis: '#737373',
  utilizationOk: '#a3a3a3',
  utilizationWarn: '#f59e0b',
  utilizationCrit: '#f87171',
  eventNamed: {
    Growth: '#e5e5e5',
    Hardware: '#a3a3a3',
    OpenShift: '#737373',
    Note: '#525252',
  },
  eventPalette: ['#e5e5e5', '#a3a3a3', '#737373', '#525252', '#f9c74f', '#f59e0b', '#2dd4bf'],
};

export function useChartColors(): ChartColors {
  const { resolvedTheme } = useTheme();
  return useMemo(() => (resolvedTheme === 'dark' ? DARK : LIGHT), [resolvedTheme]);
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
