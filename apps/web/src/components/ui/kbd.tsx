import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * Keycap chip. Two sizes so every rendered `<kbd>` in the app comes from here:
 * `default` is the raised chip used by the topbar ⌘K hint and the shortcuts
 * dialog; `xs` is the flat micro-hint that sits *inside* a chip button (the
 * BackButton's "Esc"), where the raised gradient keycap would overpower a
 * 10.5px label. Only the element, border token, and mono face are shared —
 * each size owns its own box so the two looks can't half-merge.
 */
const kbdVariants = cva('border border-border font-mono', {
  variants: {
    size: {
      default: cn(
        'inline-flex h-6 min-w-[1.5rem] items-center justify-center rounded-md',
        'bg-gradient-to-b from-muted to-muted/60',
        'px-1.5 text-[11px] font-medium text-muted-foreground',
        'shadow-[inset_0_-1px_0_rgba(0,0,0,0.06)] dark:shadow-[inset_0_-1px_0_rgba(255,255,255,0.04)]',
      ),
      xs: 'rounded px-1 py-0.5 text-[9px] font-semibold text-fg-subtle',
    },
  },
  defaultVariants: {
    size: 'default',
  },
});

export function Kbd({
  className,
  size,
  children,
  ...props
}: React.HTMLAttributes<HTMLElement> & VariantProps<typeof kbdVariants>): React.JSX.Element {
  return (
    <kbd className={cn(kbdVariants({ size, className }))} {...props}>
      {children}
    </kbd>
  );
}
