import { useQuery } from '@tanstack/react-query';

import { Sparkline } from '@/components/sparkline';
import { api } from '@/lib/api-client';

interface ClusterSparklineCellProps {
  clusterId: string;
  metricKey: string;
}

export function ClusterSparklineCell({
  clusterId,
  metricKey,
}: ClusterSparklineCellProps): React.JSX.Element {
  const today = new Date();
  const yyyyMm = (date: Date): string =>
    `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  const from = yyyyMm(today);
  const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 11, 1));
  const to = yyyyMm(end);

  const query = useQuery({
    queryKey: ['forecast', clusterId, metricKey, from, to],
    queryFn: () => api.clusters.forecast(clusterId, { metric: metricKey, from, to }),
    staleTime: 5 * 60_000,
  });

  if (query.isPending) {
    return <div className="h-7 w-[120px] animate-pulse rounded bg-muted" />;
  }
  if (query.isError || !query.data) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }

  const consumption = query.data.months.map((m) => m.consumption);
  const capacity = query.data.months.map((m) => m.capacity);
  return <Sparkline values={consumption} ceiling={capacity} />;
}
