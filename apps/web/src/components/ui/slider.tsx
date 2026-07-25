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
  /** Describes the control when it can't be operated (pairs with `disabled`). */
  'aria-describedby'?: string;
  disabled?: boolean;
  id?: string;
  className?: string;
}

/**
 * A single-thumb slider on a styled native `<input type="range">`: keyboard-
 * operable and screen-reader-labelled for free, no dependency. The steel value
 * fill is driven by `--slider-pct` (see `.range-slider` in styles.css) so the
 * track reads full-up-to-the-thumb without JS on every frame.
 *
 * @ai-note The visible track is 8px but the input's box is 24px tall (styles.css
 * draws the track on the `::-*-track` pseudo-elements, not on the input itself)
 * so the pointer target clears WCAG 2.2 AA 2.5.8's 24×24 floor. Setting a height
 * on `.range-slider` again would silently shrink the hit area back under it.
 */
export function Slider({
  value,
  min,
  max,
  step = 1,
  onValueChange,
  className,
  id,
  disabled = false,
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
      disabled={disabled}
      onChange={(e) => onValueChange(Number(e.target.value))}
      style={{ '--slider-pct': `${pct}%` } as React.CSSProperties}
      {...aria}
    />
  );
}
