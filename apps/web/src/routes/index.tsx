import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';

import { ClusterTable } from '@/components/clusters/cluster-table';
import { CreateClusterDialog } from '@/components/clusters/create-cluster-dialog';
import { ClustersEmptyState } from '@/components/clusters/empty-state';
import { Badge } from '@/components/ui/badge';
import { api } from '@/lib/api-client';

export const Route = createFileRoute('/')({
  component: DashboardPage,
});

function DashboardPage(): React.JSX.Element {
  const healthQuery = useQuery({
    queryKey: ['health'],
    queryFn: () => api.health.live(),
    refetchInterval: 30_000,
  });

  const clustersQuery = useQuery({
    queryKey: ['clusters'],
    queryFn: () => api.clusters.list(),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            {clustersQuery.data?.length
              ? `${clustersQuery.data.length} clusters tracked`
              : 'Capacity forecasts across all tracked clusters.'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ApiStatusBadge state={healthQuery.status} value={healthQuery.data?.status} />
          {clustersQuery.data && clustersQuery.data.length > 0 ? <CreateClusterDialog /> : null}
        </div>
      </div>

      {clustersQuery.isPending ? <ClusterTableSkeleton /> : null}

      {clustersQuery.isError ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
          Could not load clusters: {clustersQuery.error.message}
        </div>
      ) : null}

      {clustersQuery.data?.length === 0 ? <ClustersEmptyState /> : null}

      {clustersQuery.data && clustersQuery.data.length > 0 ? (
        <ClusterTable clusters={clustersQuery.data} />
      ) : null}
    </div>
  );
}

interface ApiStatusBadgeProps {
  state: 'pending' | 'error' | 'success';
  value: string | undefined;
}

function ApiStatusBadge({ state, value }: ApiStatusBadgeProps): React.JSX.Element {
  if (state === 'pending') {
    return <Badge variant="secondary">API: checking…</Badge>;
  }
  if (state === 'error') {
    return <Badge variant="danger">API: unreachable</Badge>;
  }
  return <Badge variant="success">API: {value}</Badge>;
}

function ClusterTableSkeleton(): React.JSX.Element {
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-12 animate-pulse rounded bg-muted/60" />
        ))}
      </div>
    </div>
  );
}
