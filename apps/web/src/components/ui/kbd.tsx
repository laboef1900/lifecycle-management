import * as React from 'react';

import { cn } from '@/lib/utils';

export function Kbd({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLElement>): React.JSX.Element {
  return (
    <kbd
      className={cn(
        'inline-flex h-6 min-w-[1.5rem] items-center justify-center rounded-md',
        'border border-border bg-gradient-to-b from-muted to-muted/60',
        'px-1.5 font-mono text-[11px] font-medium text-muted-foreground',
        'shadow-[inset_0_-1px_0_rgba(0,0,0,0.06)] dark:shadow-[inset_0_-1px_0_rgba(255,255,255,0.04)]',
        className,
      )}
      {...props}
    >
      {children}
    </kbd>
  );
}
