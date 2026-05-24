import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { api, type ClusterUpdateInputWire } from '@/lib/api-client';

interface ClusterIdentityFormProps {
  clusterId: string;
}

export function ClusterIdentityForm({ clusterId }: ClusterIdentityFormProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const clusterQuery = useQuery({
    queryKey: ['cluster', clusterId],
    queryFn: () => api.clusters.get(clusterId),
  });

  const [nameEdit, setNameEdit] = React.useState<string | null>(null);
  const [descriptionEdit, setDescriptionEdit] = React.useState<string | null>(null);
  const [validationError, setValidationError] = React.useState<string | null>(null);

  const serverName = clusterQuery.data?.name ?? '';
  const serverDescription = clusterQuery.data?.description ?? '';
  const name = nameEdit ?? serverName;
  const description = descriptionEdit ?? serverDescription;

  const mutation = useMutation({
    mutationFn: (input: ClusterUpdateInputWire) => api.clusters.update(clusterId, input),
    onSuccess: (data) => {
      queryClient.setQueryData(['cluster', clusterId], data);
      setNameEdit(null);
      setDescriptionEdit(null);
    },
  });

  const dirty =
    (nameEdit !== null && nameEdit !== serverName) ||
    (descriptionEdit !== null && descriptionEdit !== serverDescription);

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    setValidationError(null);

    if (name.trim().length === 0) {
      setValidationError('Name is required.');
      return;
    }

    const input: ClusterUpdateInputWire = {};
    if (nameEdit !== null && nameEdit !== serverName) {
      input.name = nameEdit;
    }
    if (descriptionEdit !== null && descriptionEdit !== serverDescription) {
      input.description = descriptionEdit === '' ? null : descriptionEdit;
    }
    mutation.mutate(input);
  };

  return (
    <Card className="p-4">
      <header className="mb-4">
        <h2 className="text-base font-semibold">Cluster identity</h2>
        <p className="text-sm text-fg-muted">Rename or update the description for this cluster.</p>
      </header>
      <form onSubmit={handleSubmit} className="space-y-3">
        <label className="block">
          <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-subtle">
            Name
          </span>
          <Input
            aria-label="Name"
            value={name}
            onChange={(e) => setNameEdit(e.target.value)}
            maxLength={120}
            className="mt-1"
          />
        </label>
        <label className="block">
          <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-subtle">
            Description
          </span>
          <textarea
            aria-label="Description"
            value={description}
            onChange={(e) => setDescriptionEdit(e.target.value)}
            maxLength={2000}
            rows={3}
            className="mt-1 flex w-full rounded-[var(--radius)] border border-input bg-background px-2.5 py-1.5 text-sm placeholder:text-fg-subtle focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          />
        </label>
        {validationError ? (
          <p className="text-sm text-destructive" role="alert">
            {validationError}
          </p>
        ) : null}
        <div className="flex items-center justify-end">
          <Button type="submit" variant="accent" size="sm" disabled={!dirty || mutation.isPending}>
            {mutation.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </form>
    </Card>
  );
}
