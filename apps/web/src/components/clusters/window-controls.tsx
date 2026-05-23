import { cn } from '@/lib/utils';

export type ForecastWindow = '12mo' | '24mo' | 'all';

interface WindowControlsProps {
  value: ForecastWindow;
  onChange: (value: ForecastWindow) => void;
}

const options: Array<{ value: ForecastWindow; label: string }> = [
  { value: '12mo', label: '12 mo' },
  { value: '24mo', label: '24 mo' },
  { value: 'all', label: 'All' },
];

export function WindowControls({ value, onChange }: WindowControlsProps): React.JSX.Element {
  return (
    <div
      role="group"
      aria-label="Forecast window"
      className="inline-flex rounded-md border bg-card p-0.5 text-sm"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            'rounded px-3 py-1 transition-colors',
            value === option.value
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function resolveWindow(
  selection: ForecastWindow,
  baselineDate: string,
): { from: string; to: string } {
  const now = new Date();
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const monthsAhead = (n: number): Date =>
    new Date(Date.UTC(todayStart.getUTCFullYear(), todayStart.getUTCMonth() + n, 1));

  switch (selection) {
    case '12mo':
      return { from: yyyyMm(todayStart), to: yyyyMm(monthsAhead(11)) };
    case '24mo':
      return { from: yyyyMm(todayStart), to: yyyyMm(monthsAhead(23)) };
    case 'all': {
      const baseline = new Date(`${baselineDate}T00:00:00Z`);
      return { from: yyyyMm(baseline), to: yyyyMm(monthsAhead(23)) };
    }
  }
}

function yyyyMm(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}
