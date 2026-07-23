import { cva, type VariantProps } from 'class-variance-authority';
import { AlertOctagon, AlertTriangle, CircleHelp, Info, type LucideIcon } from 'lucide-react';
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

// Status is never the border colour alone (WCAG 1.4.1 + the house "color is
// never the only signal" rule). Each non-ok status also carries a distinctly
// SHAPED icon plus a screen-reader label, so warn/crit/attention/unknown stay
// distinguishable in grayscale, forced-colors, and to assistive tech — the same
// shape-not-hue discipline as the taller crit tick on the BulletMeter.
const STATUS_META: Record<
  'unknown' | 'attention' | 'warn' | 'crit',
  { icon: LucideIcon; label: string; className: string }
> = {
  attention: { icon: Info, label: 'Attention', className: 'text-accent' },
  warn: { icon: AlertTriangle, label: 'Warning', className: 'text-warning' },
  crit: { icon: AlertOctagon, label: 'Critical', className: 'text-destructive' },
  unknown: { icon: CircleHelp, label: 'Unknown', className: 'text-fg-subtle' },
};

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
  const meta = status && status !== 'ok' ? STATUS_META[status] : null;
  const StatusIcon = meta?.icon;
  return (
    <Card className={cn(tileVariants({ status }), className)} {...props}>
      <div className="flex items-start justify-between gap-2">
        <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-subtle">
          {label}
        </p>
        {meta && StatusIcon ? (
          <span className={cn('mt-px shrink-0', meta.className)}>
            <StatusIcon className="h-3.5 w-3.5" aria-hidden />
            <span className="sr-only">{meta.label}</span>
          </span>
        ) : null}
      </div>
      <p className="mt-2 font-mono text-xl font-medium tracking-tight tabular-nums text-foreground [overflow-wrap:anywhere] sm:text-2xl">
        {value}
      </p>
      {caption ? (
        <p className="mt-1.5 text-[11px] text-fg-muted [overflow-wrap:anywhere]">{caption}</p>
      ) : null}
    </Card>
  );
}
