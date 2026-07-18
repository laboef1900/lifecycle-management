import { Slot as SlotPrimitive } from 'radix-ui';
import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[var(--radius)] text-sm font-medium transition-[color,background-color,border-color,box-shadow,transform] duration-150 ease-out active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'bg-foreground text-background shadow-[var(--shadow-card)] hover:bg-foreground/90',
        accent: 'bg-accent text-accent-foreground shadow-[var(--shadow-card)] hover:bg-accent/90',
        destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
        outline: 'border border-input bg-background hover:bg-card-hover hover:text-foreground',
        ghost: 'hover:bg-card-hover hover:text-foreground',
        link: 'text-accent underline-offset-4 hover:underline',
        // Micro-label chip: a transparent, hairline-bordered control that reads
        // as a label until hovered. Pair with `size="chip"`.
        chip: 'border border-border text-fg-muted hover:border-border-strong hover:text-foreground',
      },
      size: {
        sm: 'h-7 rounded-[var(--radius)] px-2.5 text-xs',
        default: 'h-8 px-3 py-1.5',
        lg: 'h-9 rounded-[var(--radius)] px-4',
        icon: 'h-8 w-8',
        // Chip metrics: content-height (no fixed `h-*`) so an inline <Kbd xs>
        // hint can ride along, with the mono uppercase micro-label typography.
        chip: 'flex shrink-0 px-2.5 py-1.5 font-mono text-[10.5px] font-semibold uppercase tracking-[0.1em]',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? SlotPrimitive.Root : 'button';
    return (
      <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
    );
  },
);
Button.displayName = 'Button';

export { buttonVariants };
