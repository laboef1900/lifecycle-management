import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';

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

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            Cluster list and trend sparklines arrive in the next ticket.
          </p>
        </div>
        <ApiStatusBadge state={healthQuery.status} value={healthQuery.data?.status} />
      </div>

      <div className="rounded-lg border border-dashed bg-card p-12 text-center text-sm text-muted-foreground">
        Cluster list placeholder — implemented in #13.
      </div>
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
