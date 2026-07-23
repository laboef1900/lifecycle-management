import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import * as React from 'react';
import { toast } from 'sonner';

import { ConfirmDialog } from '@/components/form/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { api } from '@/lib/api-client';

interface ClusterLifecycleCardProps {
  clusterId: string;
}

export function ClusterLifecycleCard({ clusterId }: ClusterLifecycleCardProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const clusterQuery = useQuery({
    queryKey: ['cluster', clusterId],
    queryFn: () => api.clusters.get(clusterId),
  });

  const [archiveDialogOpen, setArchiveDialogOpen] = React.useState(false);
  const [unarchiveDialogOpen, setUnarchiveDialogOpen] = React.useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = React.useState(false);

  const isArchived =
    clusterQuery.data?.archivedAt !== null && clusterQuery.data?.archivedAt !== undefined;
  const clusterName = clusterQuery.data?.name ?? '';

  const invalidateClustersLists = (): Promise<void> => {
    return queryClient.invalidateQueries({ queryKey: ['clusters'] });
  };

  const archiveMutation = useMutation({
    mutationFn: () => api.clusters.archive(clusterId),
    onSuccess: (data) => {
      queryClient.setQueryData(['cluster', clusterId], data);
      void invalidateClustersLists();
      setArchiveDialogOpen(false);
      toast.success('Cluster archived.');
    },
  });

  const unarchiveMutation = useMutation({
    mutationFn: () => api.clusters.unarchive(clusterId),
    onSuccess: (data) => {
      queryClient.setQueryData(['cluster', clusterId], data);
      void invalidateClustersLists();
      setUnarchiveDialogOpen(false);
      toast.success('Cluster unarchived.');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.clusters.delete(clusterId),
    onSuccess: () => {
      void invalidateClustersLists();
      setDeleteDialogOpen(false);
      toast.success('Cluster deleted.');
      void navigate({ to: '/' });
    },
  });

  return (
    <Card className="p-4">
      <header className="mb-4">
        <h2 className="text-base font-semibold">Lifecycle</h2>
      </header>
      <div className="space-y-4">
        {isArchived ? (
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <p className="text-sm font-medium">Unarchive cluster</p>
              <p className="text-sm text-fg-muted">
                Restore this cluster to the active list. Its forecasts, hosts, applications, and
                events are unaffected.
              </p>
            </div>
            <Button
              type="button"
              variant="accent"
              size="sm"
              onClick={() => setUnarchiveDialogOpen(true)}
            >
              Unarchive
            </Button>
          </div>
        ) : (
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <p className="text-sm font-medium">Archive cluster</p>
              <p className="text-sm text-fg-muted">
                Archived clusters are hidden by default but stay readable and restorable. Forecast
                history is preserved.
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setArchiveDialogOpen(true)}
            >
              Archive
            </Button>
          </div>
        )}
        <div className="border-t border-border" />
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <p className="text-sm font-medium">Delete cluster</p>
            <p className="text-sm text-fg-muted">
              Permanently removes this cluster, its baselines, hosts, applications, and events. This
              cannot be undone.
            </p>
          </div>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={() => setDeleteDialogOpen(true)}
          >
            Delete
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={archiveDialogOpen}
        onOpenChange={(next) => {
          setArchiveDialogOpen(next);
          if (!next) archiveMutation.reset();
        }}
        title="Archive cluster?"
        description="Archived clusters are hidden from the default list and from fleet KPIs. Forecast history is preserved and the cluster can be unarchived at any time."
        confirmLabel="Archive cluster"
        error={archiveMutation.isError ? 'Could not archive the cluster. Please try again.' : null}
        pending={archiveMutation.isPending}
        onConfirm={() => archiveMutation.mutate()}
      />
      <ConfirmDialog
        open={unarchiveDialogOpen}
        onOpenChange={(next) => {
          setUnarchiveDialogOpen(next);
          if (!next) unarchiveMutation.reset();
        }}
        title="Unarchive cluster?"
        description="Restores this cluster to the active list and fleet KPIs."
        confirmLabel="Unarchive cluster"
        error={
          unarchiveMutation.isError ? 'Could not unarchive the cluster. Please try again.' : null
        }
        pending={unarchiveMutation.isPending}
        onConfirm={() => unarchiveMutation.mutate()}
      />
      <ConfirmDialog
        open={deleteDialogOpen}
        onOpenChange={(next) => {
          setDeleteDialogOpen(next);
          if (!next) deleteMutation.reset();
        }}
        title="Delete cluster permanently?"
        description={`This removes ${clusterName} and all its hosts, applications, events, baselines, and settings. This cannot be undone.`}
        confirmLabel="Delete forever"
        destructive
        confirmPhrase={clusterName}
        error={deleteMutation.isError ? 'Could not delete the cluster. Please try again.' : null}
        pending={deleteMutation.isPending}
        onConfirm={() => deleteMutation.mutate()}
      />
    </Card>
  );
}
