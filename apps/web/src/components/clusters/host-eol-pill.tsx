import { daysUntil } from '@/lib/dates';

export function HostEolPill({ eolAt }: { eolAt: string | null }): React.JSX.Element | null {
  if (!eolAt) return null;
  const days = daysUntil(eolAt);
  const warn = days >= 0 && days <= 180;
  return (
    <span
      className={`inline-flex items-center gap-1 text-xs ${
        warn ? 'font-medium text-warning' : 'text-fg-subtle'
      }`}
      title={warn ? `Expires in ${days} days` : undefined}
    >
      {warn ? <span aria-hidden="true">⚠</span> : null}
      <span>{eolAt}</span>
    </span>
  );
}
