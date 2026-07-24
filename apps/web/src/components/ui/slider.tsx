import * as React from 'react';

import { cn } from '@/lib/utils';

interface SliderProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  onValueChange: (value: number) => void;
  /** Accessible name — the visible label is rendered by the caller. */
  'aria-label': string;
  /** Human-readable value announced to assistive tech (e.g. "3 hosts"). */
  'aria-valuetext'?: string;
  id?: string;
  className?: string;
}

/**
 * A single-thumb slider on a styled native `<input type="range">`: keyboard-
 * operable and screen-reader-labelled for free, no dependency. The steel value
 * fill is driven by `--slider-pct` (see `.range-slider` in styles.css) so the
 * track reads full-up-to-the-thumb without JS on every frame.
 */
export function Slider({
  value,
  min,
  max,
  step = 1,
  onValueChange,
  className,
  id,
  ...aria
}: SliderProps): React.JSX.Element {
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
  return (
    <input
      type="range"
      id={id}
      className={cn('range-slider', className)}
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onValueChange(Number(e.target.value))}
      style={{ '--slider-pct': `${pct}%` } as React.CSSProperties}
      {...aria}
    />
  );
}
