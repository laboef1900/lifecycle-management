const DAY_MS = 86_400_000;

function daysUntil(dateStr: string): number {
  return Math.round((new Date(dateStr).getTime() - Date.now()) / DAY_MS);
}

export function HostEolPill({ eolAt }: { eolAt: string | null }): React.JSX.Element | null {
  if (!eolAt) return null;
  const days = daysUntil(eolAt);
  const warn = days >= 0 && days <= 180;
  return (
    <span
      className={`inline-flex items-center gap-1 text-xs ${
        warn ? 'font-medium text-amber-700' : 'text-zinc-600'
      }`}
      title={warn ? `Expires in ${days} days` : undefined}
    >
      {warn ? <span aria-hidden="true">⚠</span> : null}
      <span>{eolAt}</span>
    </span>
  );
}
