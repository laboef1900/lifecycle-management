import * as React from 'react';

import { cn } from '@/lib/utils';

export const Table = React.forwardRef<HTMLTableElement, React.HTMLAttributes<HTMLTableElement>>(
  ({ className, ...props }, ref) => (
    <div className="relative w-full overflow-auto">
      <table ref={ref} className={cn('w-full caption-bottom text-sm', className)} {...props} />
    </div>
  ),
);
Table.displayName = 'Table';

export const TableHeader = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <thead
    ref={ref}
    className={cn(
      'border-b border-border text-xs uppercase tracking-wider text-fg-subtle font-medium',
      className,
    )}
    {...props}
  />
));
TableHeader.displayName = 'TableHeader';

export const TableBody = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tbody ref={ref} className={cn('[&_tr:last-child]:border-0', className)} {...props} />
));
TableBody.displayName = 'TableBody';

export const TableRow = React.forwardRef<
  HTMLTableRowElement,
  React.HTMLAttributes<HTMLTableRowElement>
>(({ className, ...props }, ref) => (
  <tr
    ref={ref}
    className={cn(
      'border-b border-border h-9 transition-colors hover:bg-card-hover data-[state=selected]:bg-muted',
      className,
    )}
    {...props}
  />
));
TableRow.displayName = 'TableRow';

/**
 * `sticky` (#243 Part B) pins a column to the right edge of the scroll
 * container — e.g. an Actions column that would otherwise sit off-canvas at
 * phone width with no scroll affordance. Opt-in per cell so tables that don't
 * need it (there's only one column to pin per table, and not every table
 * needs it) are unaffected. The opaque `bg-card` plus `group-hover:bg-card-hover`
 * on `TableCell` keep the scrolling columns behind it from showing through in
 * either theme; pair with `className="group"` on the owning `TableRow`.
 */
interface StickyProps {
  sticky?: boolean;
}

export const TableHead = React.forwardRef<
  HTMLTableCellElement,
  React.ThHTMLAttributes<HTMLTableCellElement> & StickyProps
>(({ className, sticky, ...props }, ref) => (
  <th
    ref={ref}
    className={cn(
      'h-9 px-3 text-left align-middle text-xs font-medium text-fg-subtle [&:has([role=checkbox])]:pr-0',
      sticky && 'sticky right-0 z-10 border-l border-border bg-card',
      className,
    )}
    {...props}
  />
));
TableHead.displayName = 'TableHead';

export const TableCell = React.forwardRef<
  HTMLTableCellElement,
  React.TdHTMLAttributes<HTMLTableCellElement> & StickyProps
>(({ className, sticky, ...props }, ref) => (
  <td
    ref={ref}
    className={cn(
      'px-3 py-2 align-middle text-sm [&:has([role=checkbox])]:pr-0',
      sticky && 'sticky right-0 z-10 border-l border-border bg-card group-hover:bg-card-hover',
      className,
    )}
    {...props}
  />
));
TableCell.displayName = 'TableCell';
