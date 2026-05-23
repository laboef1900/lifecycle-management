import type { EventCategory } from '@lcm/shared';
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
  event: Record<EventCategory, string>;
}

const LIGHT: ChartColors = {
  consumption: 'oklch(50% 0.22 262)',
  consumptionFill: 'oklch(50% 0.22 262 / 0.18)',
  capacity: 'oklch(58% 0.22 25)',
  grid: 'oklch(90% 0.01 257)',
  axis: 'oklch(50% 0.02 257)',
  utilizationOk: 'oklch(60% 0.18 142)',
  utilizationWarn: 'oklch(70% 0.2 80)',
  utilizationCrit: 'oklch(58% 0.22 25)',
  event: {
    growth: 'oklch(60% 0.15 50)',
    hardware_change: 'oklch(55% 0.18 145)',
    openshift: 'oklch(55% 0.2 290)',
    note: 'oklch(55% 0.02 260)',
  },
};

const DARK: ChartColors = {
  consumption: 'oklch(68% 0.18 262)',
  consumptionFill: 'oklch(68% 0.18 262 / 0.22)',
  capacity: 'oklch(70% 0.18 25)',
  grid: 'oklch(28% 0.01 257)',
  axis: 'oklch(68% 0.02 257)',
  utilizationOk: 'oklch(72% 0.12 142)',
  utilizationWarn: 'oklch(78% 0.14 80)',
  utilizationCrit: 'oklch(70% 0.18 25)',
  event: {
    growth: 'oklch(75% 0.12 50)',
    hardware_change: 'oklch(72% 0.13 145)',
    openshift: 'oklch(72% 0.15 290)',
    note: 'oklch(70% 0.02 260)',
  },
};

export function useChartColors(): ChartColors {
  const { resolvedTheme } = useTheme();
  return useMemo(() => (resolvedTheme === 'dark' ? DARK : LIGHT), [resolvedTheme]);
}
