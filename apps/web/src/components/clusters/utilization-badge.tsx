import { Badge } from '@/components/ui/badge';

interface UtilizationBadgeProps {
  /** 0..1 ratio (consumption / capacity). */
  value: number;
  warn?: number;
  crit?: number;
}

export function UtilizationBadge({
  value,
  warn = 0.7,
  crit = 0.9,
}: UtilizationBadgeProps): React.JSX.Element {
  const variant = value >= crit ? 'danger' : value >= warn ? 'warning' : 'success';
  const pct = (value * 100).toFixed(1);
  return (
    <Badge variant={variant} dot>
      {pct}%
    </Badge>
  );
}
