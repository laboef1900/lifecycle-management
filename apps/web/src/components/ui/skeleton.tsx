import * as React from 'react';

import { cn } from '@/lib/utils';

/** Shimmering placeholder block; size it via className (h-*, w-*). */
export function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div
      aria-hidden
      className={cn(
        'animate-shimmer rounded-[var(--radius)] bg-[linear-gradient(90deg,var(--muted)_25%,var(--card-hover)_37%,var(--muted)_63%)] bg-[length:400%_100%]',
        className,
      )}
      {...props}
    />
  );
}
