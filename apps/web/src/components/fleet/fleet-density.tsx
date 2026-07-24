import { LayoutGrid, Rows3 } from 'lucide-react';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

export type FleetDensity = 'comfortable' | 'compact';

const OPTIONS: Array<{ value: FleetDensity; label: string; Icon: typeof LayoutGrid }> = [
  { value: 'comfortable', label: 'Comfortable', Icon: LayoutGrid },
  { value: 'compact', label: 'Compact', Icon: Rows3 },
];

/**
 * Fleet console density toggle (critique fix): a large fleet is a long scroll of
 * ~260px chart tiles with no way to scan more per screen. "Compact" drops the
 * per-tile forecast chart — the BulletMeter added alongside carries utilization
 * at a glance — so a 20–30 cluster fleet reads in a fraction of the height. A
 * two-button segmented group (aria-pressed), persisted by the console.
 */
export function FleetDensityToggle({
  value,
  onValueChange,
}: {
  value: FleetDensity;
  onValueChange: (next: FleetDensity) => void;
}): React.JSX.Element {
  return (
    <div
      role="group"
      aria-label="Tile density"
      className="inline-flex h-8 items-center gap-0.5 rounded-[var(--radius)] border border-border p-0.5"
    >
      {OPTIONS.map(({ value: optionValue, label, Icon }) => {
        const active = value === optionValue;
        return (
          <Tooltip key={optionValue}>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={`${label} view`}
                aria-pressed={active}
                onClick={() => onValueChange(optionValue)}
                className={cn(
                  'inline-flex h-7 w-7 items-center justify-center rounded-[calc(var(--radius)-2px)] transition-colors',
                  active
                    ? 'bg-card-hover text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <Icon className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent>{label}</TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
