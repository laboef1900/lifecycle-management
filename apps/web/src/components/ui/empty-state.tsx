import * as React from 'react';

import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

export interface EmptyStateProps {
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
}: EmptyStateProps): React.JSX.Element {
  return (
    <Card
      className={cn(
        'flex flex-col items-center justify-center gap-2 border-dashed p-8 text-center shadow-none',
        className,
      )}
    >
      {icon ? (
        <div aria-hidden className="mb-1 text-fg-subtle [&>svg]:h-8 [&>svg]:w-8">
          {icon}
        </div>
      ) : null}
      <p className="text-sm font-medium">{title}</p>
      {description ? <p className="max-w-sm text-xs text-fg-muted">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </Card>
  );
}
