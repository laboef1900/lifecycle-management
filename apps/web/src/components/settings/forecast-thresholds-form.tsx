import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api-client';

type PctInput = number | '';

export function ForecastThresholdsForm(): React.JSX.Element {
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({
    queryKey: ['tenant-settings'],
    queryFn: () => api.settings.tenant.get(),
  });

  // Local edits override the server-derived defaults. `null` means "not edited
  // — use the server value". Keeping edits decoupled from server data avoids
  // the setState-in-effect anti-pattern.
  const [warnEdit, setWarnEdit] = React.useState<PctInput | null>(null);
  const [critEdit, setCritEdit] = React.useState<PctInput | null>(null);
  const [validationError, setValidationError] = React.useState<string | null>(null);

  const initialWarn = settingsQuery.data
    ? Math.round(settingsQuery.data.warnThreshold * 100)
    : null;
  const initialCrit = settingsQuery.data
    ? Math.round(settingsQuery.data.critThreshold * 100)
    : null;

  const warnPct: PctInput = warnEdit ?? initialWarn ?? '';
  const critPct: PctInput = critEdit ?? initialCrit ?? '';

  const mutation = useMutation({
    mutationFn: (input: { warnThreshold: number; critThreshold: number }) =>
      api.settings.tenant.update(input),
    onSuccess: (data) => {
      queryClient.setQueryData(['tenant-settings'], data);
      // After save succeeds the server values now match; clear local edits so
      // the dirty check resets.
      setWarnEdit(null);
      setCritEdit(null);
    },
  });

  const dirty =
    typeof warnPct === 'number' &&
    typeof critPct === 'number' &&
    initialWarn !== null &&
    initialCrit !== null &&
    (warnPct !== initialWarn || critPct !== initialCrit);

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    setValidationError(null);
    if (typeof warnPct !== 'number' || typeof critPct !== 'number') return;
    if (warnPct >= critPct) {
      setValidationError('Warn must be less than crit.');
      return;
    }
    mutation.mutate({ warnThreshold: warnPct / 100, critThreshold: critPct / 100 });
  };

  const parseInput = (raw: string): PctInput => (raw === '' ? '' : Number(raw));

  return (
    <Card className="p-4">
      <header className="mb-4">
        <h2 className="text-base font-semibold">Forecast thresholds</h2>
        <p className="text-sm text-fg-muted">
          Default warn/crit bands. Per-cluster overrides apply on the cluster's Settings tab.
        </p>
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
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-fg-subtle">
            {settingsQuery.data ? 'Source: Saved tenant settings' : 'Source: System defaults'}
          </span>
          <Button type="submit" variant="accent" size="sm" disabled={!dirty || mutation.isPending}>
            {mutation.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </form>
    </Card>
  );
}
