import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as React from 'react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ApiError, api } from '@/lib/api-client';

interface ThresholdOverridesFormProps {
  clusterId: string;
}

function pctOrEmpty(value: number | null): number | '' {
  if (value === null) return '';
  return Math.round(value * 100);
}

function parseInput(value: string): number | '' {
  return value === '' ? '' : Number(value);
}

export function ThresholdOverridesForm({
  clusterId,
}: ThresholdOverridesFormProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({
    queryKey: ['cluster-settings', clusterId],
    queryFn: () => api.settings.cluster.get(clusterId),
  });

  // Edit state overlays server data. null = use server value; a number/'' = user-edited.
  const [warnEdit, setWarnEdit] = React.useState<number | '' | null>(null);
  const [critEdit, setCritEdit] = React.useState<number | '' | null>(null);
  const [validationError, setValidationError] = React.useState<string | null>(null);

  const serverWarn = pctOrEmpty(settingsQuery.data?.warnThreshold ?? null);
  const serverCrit = pctOrEmpty(settingsQuery.data?.critThreshold ?? null);
  const warnPct: number | '' = warnEdit ?? serverWarn;
  const critPct: number | '' = critEdit ?? serverCrit;

  const saveMutation = useMutation({
    mutationFn: (input: { warnThreshold: number | null; critThreshold: number | null }) =>
      api.settings.cluster.update(clusterId, input),
    onSuccess: (data) => {
      queryClient.setQueryData(['cluster-settings', clusterId], data);
      void queryClient.invalidateQueries({ queryKey: ['forecast', clusterId] });
      setWarnEdit(null);
      setCritEdit(null);
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'Could not save thresholds'),
  });

  const resetMutation = useMutation({
    mutationFn: () => api.settings.cluster.reset(clusterId),
    onSuccess: (data) => {
      queryClient.setQueryData(['cluster-settings', clusterId], data);
      void queryClient.invalidateQueries({ queryKey: ['forecast', clusterId] });
      setWarnEdit(null);
      setCritEdit(null);
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'Could not reset thresholds'),
  });

  const isCurrentlyOverridden =
    settingsQuery.data?.effective.source === 'cluster' ||
    (settingsQuery.data?.warnThreshold ?? null) !== null ||
    (settingsQuery.data?.critThreshold ?? null) !== null;

  const canSave =
    (typeof warnPct === 'number' || typeof critPct === 'number') && !saveMutation.isPending;

  const effective = settingsQuery.data?.effective;
  const sourceLabel = isCurrentlyOverridden ? 'Cluster override' : 'Inherited from tenant defaults';

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    setValidationError(null);
    if (typeof warnPct === 'number' && typeof critPct === 'number' && warnPct >= critPct) {
      setValidationError('Warn must be less than crit.');
      return;
    }
    saveMutation.mutate({
      warnThreshold: typeof warnPct === 'number' ? warnPct / 100 : null,
      critThreshold: typeof critPct === 'number' ? critPct / 100 : null,
    });
  };

  return (
    <Card className="p-4">
      <header className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold">Thresholds</h2>
          <p className="text-sm text-fg-muted">
            Override tenant defaults for this cluster, or inherit them.
          </p>
        </div>
        <Badge variant={isCurrentlyOverridden ? 'accent' : 'default'}>{sourceLabel}</Badge>
      </header>
      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-subtle">
              Warn %
            </span>
            <Input
              type="number"
              min={1}
              max={99}
              aria-label="Warn %"
              value={warnPct}
              placeholder={effective ? String(Math.round(effective.warn * 100)) : ''}
              onChange={(e) => setWarnEdit(parseInput(e.target.value))}
              className="mt-1"
            />
          </label>
          <label className="block">
            <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-subtle">
              Crit %
            </span>
            <Input
              type="number"
              min={1}
              max={99}
              aria-label="Crit %"
              value={critPct}
              placeholder={effective ? String(Math.round(effective.crit * 100)) : ''}
              onChange={(e) => setCritEdit(parseInput(e.target.value))}
              className="mt-1"
            />
          </label>
        </div>
        {validationError ? (
          <p className="text-sm text-destructive" role="alert">
            {validationError}
          </p>
        ) : null}
        <div className="flex items-center justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!isCurrentlyOverridden || resetMutation.isPending}
            onClick={() => resetMutation.mutate()}
          >
            Reset to inherited
          </Button>
          <Button type="submit" variant="accent" size="sm" disabled={!canSave}>
            {saveMutation.isPending ? 'Saving…' : 'Save override'}
          </Button>
        </div>
      </form>
    </Card>
  );
}
