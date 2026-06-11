import * as React from 'react';

import { cn } from '@/lib/utils';

// Tones set the TEXT color; the dot paints from bg-current so the
// currentColor halo below stays in sync with the tone.
const toneClass = {
  ok: 'text-success',
  warn: 'text-warning',
  crit: 'text-destructive',
  neutral: 'text-fg-subtle',
} as const;

export interface StatusDotProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone: keyof typeof toneClass;
}

/** Soft-halo status indicator (decorative — pair with visible/aria text). */
export function StatusDot({ tone, className, ...props }: StatusDotProps): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-block h-1.5 w-1.5 rounded-full bg-current shadow-[0_0_0_3px_color-mix(in_oklab,currentColor_15%,transparent)]',
        toneClass[tone],
        className,
      )}
      {...props}
    />
  );
}
