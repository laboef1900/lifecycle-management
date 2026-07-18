import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

const tileVariants = cva('p-3.5 transition-colors', {
  variants: {
    status: {
      ok: '',
      // Unknown (capacity 0): a neutral border — visibly not healthy-green and not
      // alarm-red, a legible gap rather than a reassuring lie (Q9d, #200).
      unknown: 'border-l-2 border-l-border',
      attention: 'border-l-2 border-l-accent',
      warn: 'border-l-2 border-l-warning',
      crit: 'border-l-2 border-l-destructive',
    },
  },
  defaultVariants: { status: 'ok' },
});

export interface KpiTileProps
  extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof tileVariants> {
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
    <Card className={cn(tileVariants({ status }), className)} {...props}>
      <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-subtle">{label}</p>
      <p className="mt-2 font-mono text-xl font-medium tracking-tight tabular-nums text-foreground [overflow-wrap:anywhere] sm:text-2xl">
        {value}
      </p>
      {caption ? (
        <p className="mt-1.5 text-[11px] text-fg-muted [overflow-wrap:anywhere]">{caption}</p>
      ) : null}
    </Card>
  );
}
