import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

const dotVariants = cva('h-1.5 w-1.5 rounded-full', {
  variants: {
    status: {
      ok: 'bg-success',
      warn: 'bg-warning',
      crit: 'bg-destructive',
      attention: 'bg-accent',
    },
  },
});

export interface KpiTileProps
  extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof dotVariants> {
  label: string;
  value: string;
  caption?: string;
}

export function KpiTile({
  label,
  value,
  caption,
  status,
  className,
  ...props
}: KpiTileProps): React.JSX.Element {
  return (
    <Card className={cn('p-5', className)} {...props}>
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className="mt-1.5 text-2xl font-semibold tracking-tight [overflow-wrap:anywhere] sm:text-3xl">
        {value}
      </p>
      {caption || status ? (
        <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground [overflow-wrap:anywhere]">
          {status ? <span aria-hidden className={dotVariants({ status })} /> : null}
          {caption}
        </p>
      ) : null}
    </Card>
  );
}
