import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-[var(--radius)] border px-2 py-0.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
  {
    variants: {
      variant: {
        default: 'border-border bg-muted text-foreground',
        accent: 'border-transparent bg-accent-soft text-accent',
        outline: 'border-border text-fg-muted',
        success: 'border-success/30 bg-success/10 text-success',
        warning: 'border-warning/30 bg-warning/10 text-warning',
        danger: 'border-destructive/30 bg-destructive/10 text-destructive',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

const dotColor: Record<NonNullable<VariantProps<typeof badgeVariants>['variant']>, string> = {
  default: 'bg-fg-muted',
  accent: 'bg-accent',
  outline: 'bg-fg-subtle',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-destructive',
};

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {
  dot?: boolean;
}

export function Badge({
  className,
  variant,
  dot,
  children,
  ...props
}: BadgeProps): React.JSX.Element {
  const resolvedVariant = variant ?? 'default';
  return (
    <span
      data-variant={resolvedVariant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    >
      {dot ? (
        <span aria-hidden className={cn('h-1.5 w-1.5 rounded-full', dotColor[resolvedVariant])} />
      ) : null}
      {children}
    </span>
  );
}
