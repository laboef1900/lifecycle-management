import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/**
 * `default` is the in-panel empty state (hosts/items tabs, settings panels);
 * `hero` is the full bento-area presentation used when the empty state *is*
 * the page — larger padding, a display-font title and a minimum height so it
 * fills the space the cluster-tile grid would occupy.
 */
const emptyStateVariants = cva(
  'flex flex-col items-center justify-center border-dashed text-center shadow-none',
  {
    variants: {
      size: {
        default: 'gap-2 p-8',
        hero: 'min-h-[320px] gap-4 p-12',
      },
    },
    defaultVariants: { size: 'default' },
  },
);

const iconVariants = cva('text-fg-subtle', {
  variants: {
    size: {
      default: 'mb-1 [&>svg]:h-8 [&>svg]:w-8',
      hero: '[&>svg]:h-10 [&>svg]:w-10',
    },
  },
  defaultVariants: { size: 'default' },
});

// The title/description pair is always wrapped so the gap between them stays
// independent of the container's flex gap (which differs per size).
const textVariants = cva('', {
  variants: { size: { default: 'space-y-2', hero: 'space-y-1' } },
  defaultVariants: { size: 'default' },
});

const titleVariants = cva('', {
  variants: { size: { default: 'text-sm font-medium', hero: 'font-display text-xl' } },
  defaultVariants: { size: 'default' },
});

// `mx-auto` in both sizes: the description is width-capped but the title is not,
// so inside the shrink-to-fit text wrapper a title wider than the cap would
// otherwise left-align the description instead of centring it.
const descriptionVariants = cva('mx-auto text-fg-muted', {
  variants: {
    size: { default: 'max-w-sm text-xs', hero: 'max-w-md text-sm' },
  },
  defaultVariants: { size: 'default' },
});

const actionVariants = cva('', {
  variants: { size: { default: 'mt-2', hero: '' } },
  defaultVariants: { size: 'default' },
});

export interface EmptyStateProps extends VariantProps<typeof emptyStateVariants> {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
  size,
}: EmptyStateProps): React.JSX.Element {
  return (
    <Card className={cn(emptyStateVariants({ size }), className)}>
      {icon ? (
        <div aria-hidden className={iconVariants({ size })}>
          {icon}
        </div>
      ) : null}
      <div className={textVariants({ size })}>
        <p className={titleVariants({ size })}>{title}</p>
        {description ? <p className={descriptionVariants({ size })}>{description}</p> : null}
      </div>
      {action ? <div className={actionVariants({ size })}>{action}</div> : null}
    </Card>
  );
}
