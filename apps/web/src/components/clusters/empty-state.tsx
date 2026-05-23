import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Database } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { api } from '@/lib/api-client';

import { CreateClusterDialog } from './create-cluster-dialog';

const REFERENCE_CLUSTERS = [
  { name: 'CL-DMZ-P1', baselineConsumption: 3378, baselineCapacity: 7680 },
  { name: 'CL-Prod-P2', baselineConsumption: 19188, baselineCapacity: 40960 },
  { name: 'CL-Test-P2', baselineConsumption: 3345, baselineCapacity: 8192 },
  { name: 'CL-Prod-P2-Oracle', baselineConsumption: 1564, baselineCapacity: 4096 },
];

export function ClustersEmptyState(): React.JSX.Element {
  const queryClient = useQueryClient();
  const seedMutation = useMutation({
    mutationFn: async () => {
      for (const cluster of REFERENCE_CLUSTERS) {
        await api.clusters.create({
          name: cluster.name,
          baselineDate: '2026-05-01',
          baselines: [
            {
              metricTypeKey: 'memory_gb',
              baselineConsumption: cluster.baselineConsumption,
              baselineCapacity: cluster.baselineCapacity,
            },
          ],
        });
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['clusters'] });
      toast.success(`Seeded ${REFERENCE_CLUSTERS.length} reference clusters`);
    },
    onError: () => toast.error('Seed failed — some clusters may already exist'),
  });

  return (
    <Card className="flex flex-col items-center justify-center border-dashed p-12 text-center">
      <Database className="mb-3 h-8 w-8 text-muted-foreground" aria-hidden />
      <h2 className="text-lg font-semibold">No clusters yet</h2>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        Add a cluster to start tracking memory capacity and forecasting growth.
      </p>
      <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
        <CreateClusterDialog />
        {import.meta.env.DEV ? (
          <Button
            variant="outline"
            disabled={seedMutation.isPending}
            onClick={() => seedMutation.mutate()}
          >
            {seedMutation.isPending ? 'Seeding…' : 'Seed sample data (dev)'}
          </Button>
        ) : null}
      </div>
    </Card>
  );
}
