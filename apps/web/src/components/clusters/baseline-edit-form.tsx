import type { MetricStateResponse } from '@lcm/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as React from 'react';
import { toast } from 'sonner';

import { ConfirmDialog } from '@/components/form/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { api, describeApiError, type ClusterUpdateInputWire } from '@/lib/api-client';

interface BaselineEditFormProps {
  clusterId: string;
}

interface MetricEdit {
  consumption: string | null;
  capacity: string | null;
}

function parseNumber(value: string): number | null {
  if (value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function BaselineEditForm({ clusterId }: BaselineEditFormProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const clusterQuery = useQuery({
    queryKey: ['cluster', clusterId],
    queryFn: () => api.clusters.get(clusterId),
  });

  const [dateEdit, setDateEdit] = React.useState<string | null>(null);
  const [metricEdits, setMetricEdits] = React.useState<Record<string, MetricEdit>>({});
  const [confirmOpen, setConfirmOpen] = React.useState(false);

  const serverDate = clusterQuery.data?.baselineDate ?? '';
  const metrics = clusterQuery.data?.metrics ?? [];

  const date = dateEdit ?? serverDate;

  const getMetricRawValue = (
    metric: MetricStateResponse,
    field: 'consumption' | 'capacity',
  ): string => {
    const edit = metricEdits[metric.metricTypeKey];
    if (edit && edit[field] !== null) return edit[field] as string;
    const serverValue =
      field === 'consumption' ? metric.baselineConsumption : metric.baselineCapacity;
    return String(serverValue);
  };

  const getMetricNumericValue = (
    metric: MetricStateResponse,
    field: 'consumption' | 'capacity',
  ): number | null => {
    const edit = metricEdits[metric.metricTypeKey];
    if (edit && edit[field] !== null) return parseNumber(edit[field] as string);
    return field === 'consumption' ? metric.baselineConsumption : metric.baselineCapacity;
  };

  const setMetricValue = (key: string, field: 'consumption' | 'capacity', raw: string): void => {
    setMetricEdits((prev) => {
      const current = prev[key] ?? { consumption: null, capacity: null };
      return { ...prev, [key]: { ...current, [field]: raw } };
    });
  };

  const mutation = useMutation({
    mutationFn: (input: ClusterUpdateInputWire) => api.clusters.update(clusterId, input),
    onSuccess: (data) => {
      queryClient.setQueryData(['cluster', clusterId], data);
      void queryClient.invalidateQueries({ queryKey: ['forecast', clusterId] });
      void queryClient.invalidateQueries({ queryKey: ['clusters'] });
      setDateEdit(null);
      setMetricEdits({});
      setConfirmOpen(false);
    },
    onError: (err) => toast.error(describeApiError(err, 'Could not save baseline')),
  });

  const dateChanged = dateEdit !== null && dateEdit !== serverDate;
  const baselinesChanged = metrics.some((m) => {
    const edit = metricEdits[m.metricTypeKey];
    if (!edit) return false;
    const consumption = edit.consumption !== null ? parseNumber(edit.consumption) : null;
    const capacity = edit.capacity !== null ? parseNumber(edit.capacity) : null;
    return (
      (consumption !== null && consumption !== m.baselineConsumption) ||
      (capacity !== null && capacity !== m.baselineCapacity)
    );
  });
  const dirty = dateChanged || baselinesChanged;

  const handleSave = (e: React.FormEvent): void => {
    e.preventDefault();
    if (!dirty) return;
    setConfirmOpen(true);
  };

  const handleConfirm = (): void => {
    const invalidMetric = metrics.find((m) => {
      const edit = metricEdits[m.metricTypeKey];
      return (
        (edit?.consumption !== null &&
          edit?.consumption !== undefined &&
          parseNumber(edit.consumption) === null) ||
        (edit?.capacity !== null &&
          edit?.capacity !== undefined &&
          parseNumber(edit.capacity) === null)
      );
    });
    if (invalidMetric) {
      toast.error(`Invalid number for ${invalidMetric.metricTypeKey}`);
      setConfirmOpen(false);
      return;
    }
    const input: ClusterUpdateInputWire = {};
    if (dateChanged) input.baselineDate = date;
    if (baselinesChanged) {
      input.baselines = metrics.map((m) => ({
        metricTypeKey: m.metricTypeKey,
        baselineConsumption: getMetricNumericValue(m, 'consumption') ?? m.baselineConsumption,
        baselineCapacity: getMetricNumericValue(m, 'capacity') ?? m.baselineCapacity,
      }));
    }
    mutation.mutate(input);
  };

  return (
    <Card className="p-4">
      <header className="mb-4">
        <h2 className="text-base font-semibold">Baseline</h2>
        <p className="text-sm text-fg-muted">
          The starting date and per-metric values that every forecast point is computed from.
        </p>
      </header>
      <form onSubmit={handleSave} className="space-y-3">
        <label className="block">
          <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-subtle">
            Baseline date
          </span>
          <Input
            type="date"
            aria-label="Baseline date"
            value={date}
            onChange={(e) => setDateEdit(e.target.value)}
            className="mt-1"
          />
        </label>
        {metrics.map((m) => (
          <div
            key={m.metricTypeKey}
            className="space-y-2 rounded-[var(--radius)] border border-border p-3"
          >
            <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-subtle">
              {m.metricTypeDisplayName} ({m.unit})
            </p>
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-[11px] text-fg-muted">Baseline consumption</span>
                <Input
                  type="number"
                  step="any"
                  min={0}
                  aria-label={`${m.metricTypeDisplayName} baseline consumption`}
                  value={getMetricRawValue(m, 'consumption')}
                  onChange={(e) => setMetricValue(m.metricTypeKey, 'consumption', e.target.value)}
                  className="mt-1"
                />
              </label>
              <label className="block">
                <span className="text-[11px] text-fg-muted">Baseline capacity</span>
                <Input
                  type="number"
                  step="any"
                  min={0}
                  aria-label={`${m.metricTypeDisplayName} baseline capacity`}
                  value={getMetricRawValue(m, 'capacity')}
                  onChange={(e) => setMetricValue(m.metricTypeKey, 'capacity', e.target.value)}
                  className="mt-1"
                />
              </label>
            </div>
          </div>
        ))}
        <div className="flex items-center justify-end">
          <Button
            type="submit"
            variant="destructive"
            size="sm"
            disabled={!dirty || mutation.isPending}
          >
            Save baseline
          </Button>
        </div>
      </form>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Rewrite baseline?"
        description="Changing the baseline date or values rewrites every forecast point for this cluster. Confirm only if you intentionally want to reset historical assumptions."
        confirmLabel="Rewrite baseline"
        destructive
        pending={mutation.isPending}
        onConfirm={handleConfirm}
      />
    </Card>
  );
}
