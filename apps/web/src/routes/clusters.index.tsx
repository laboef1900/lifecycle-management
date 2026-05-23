import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { AlertTriangle } from 'lucide-react';

import { ClusterTable } from '@/components/clusters/cluster-table';
import { CreateClusterDialog } from '@/components/clusters/create-cluster-dialog';
import { ClustersEmptyState } from '@/components/clusters/empty-state';
import { Card } from '@/components/ui/card';
import { api } from '@/lib/api-client';

export const Route = createFileRoute('/clusters/')({
  component: ClustersPage,
});

function ClustersPage(): React.JSX.Element {
  const clustersQuery = useQuery({
    queryKey: ['clusters'],
    queryFn: () => api.clusters.list(),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-[1.625rem] font-semibold tracking-tight">Clusters</h1>
          <p className="text-sm text-muted-foreground">
            {clustersQuery.data?.length
              ? `${clustersQuery.data.length} clusters tracked`
              : 'Capacity forecasts across all tracked clusters.'}
          </p>
        </div>
        {clustersQuery.data && clustersQuery.data.length > 0 ? <CreateClusterDialog /> : null}
      </div>

      {clustersQuery.isPending ? <ClusterTableSkeleton /> : null}

      {clustersQuery.isError ? (
        <Card className="flex items-start gap-3 border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>Could not load clusters: {clustersQuery.error.message}</span>
        </Card>
      ) : null}

      {clustersQuery.data?.length === 0 ? <ClustersEmptyState /> : null}

      {clustersQuery.data && clustersQuery.data.length > 0 ? (
        <ClusterTable clusters={clustersQuery.data} />
      ) : null}
    </div>
  );
}

function ClusterTableSkeleton(): React.JSX.Element {
  return (
    <Card className="p-4">
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-12 animate-pulse rounded bg-muted" />
        ))}
      </div>
    </Card>
  );
}
