import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        destructive: 'border-transparent bg-destructive text-destructive-foreground',
        outline: 'text-foreground',
        success: 'border-success/30 bg-success/15 text-success-strong',
        warning: 'border-warning/30 bg-warning/15 text-warning-strong',
        danger: 'border-destructive/30 bg-destructive/15 text-destructive-strong',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

const dotColor: Record<NonNullable<VariantProps<typeof badgeVariants>['variant']>, string> = {
  default: 'bg-primary-foreground',
  secondary: 'bg-muted-foreground',
  destructive: 'bg-destructive-foreground',
  outline: 'bg-muted-foreground',
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
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props}>
      {dot ? (
        <span
          aria-hidden
          className={cn('h-1.5 w-1.5 rounded-full', dotColor[variant ?? 'default'])}
        />
      ) : null}
      {children}
    </span>
  );
}
