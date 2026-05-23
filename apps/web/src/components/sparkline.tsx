import { cn } from '@/lib/utils';

interface SparklineProps {
  /** Numeric series, oldest to newest. */
  values: number[];
  /** Optional second series rendered as a stepped ceiling line. */
  ceiling?: number[];
  width?: number;
  height?: number;
  className?: string;
}

export function Sparkline({
  values,
  ceiling,
  width = 120,
  height = 28,
  className,
}: SparklineProps): React.JSX.Element | null {
  if (values.length < 2) return null;

  const allPoints = ceiling ? [...values, ...ceiling] : values;
  const min = Math.min(...allPoints);
  const max = Math.max(...allPoints);
  const span = max - min || 1;
  const padX = 2;
  const padY = 2;
  const usableW = width - padX * 2;
  const usableH = height - padY * 2;

  const project = (vals: number[]): string =>
    vals
      .map((v, i) => {
        const x = padX + (i / (vals.length - 1)) * usableW;
        const y = padY + usableH - ((v - min) / span) * usableH;
        return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(' ');

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cn('overflow-visible', className)}
      role="img"
      aria-label="12 month utilization trend"
    >
      {ceiling ? (
        <path
          d={project(ceiling)}
          fill="none"
          stroke="oklch(55% 0.20 25)"
          strokeWidth="1.25"
          strokeDasharray="3 2"
          strokeLinecap="round"
        />
      ) : null}
      <path
        d={project(values)}
        fill="none"
        stroke="oklch(45% 0.15 250)"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
