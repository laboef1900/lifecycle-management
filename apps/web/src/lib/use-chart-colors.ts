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
  event: {
    growth: '#171717',
    hardware_change: '#525252',
    openshift: '#737373',
    note: '#a3a3a3',
  },
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
  event: {
    growth: '#e5e5e5',
    hardware_change: '#a3a3a3',
    openshift: '#737373',
    note: '#525252',
  },
};

export function useChartColors(): ChartColors {
  const { resolvedTheme } = useTheme();
  return useMemo(() => (resolvedTheme === 'dark' ? DARK : LIGHT), [resolvedTheme]);
}
