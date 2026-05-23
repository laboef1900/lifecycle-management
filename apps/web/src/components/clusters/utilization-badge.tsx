import { Badge } from '@/components/ui/badge';

interface UtilizationBadgeProps {
  /** 0..1 ratio (consumption / capacity). */
  value: number;
}

export function UtilizationBadge({ value }: UtilizationBadgeProps): React.JSX.Element {
  const variant = value >= 0.9 ? 'danger' : value >= 0.7 ? 'warning' : 'success';
  const pct = (value * 100).toFixed(1);
  return (
    <Badge variant={variant} dot>
      {pct}%
    </Badge>
  );
}
