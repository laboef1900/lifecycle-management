import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as React from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { api, describeApiError } from '@/lib/api-client';

type NumInput = number | '';

export function ForecastThresholdsForm(): React.JSX.Element {
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({
    queryKey: ['tenant-settings'],
    queryFn: () => api.settings.tenant.get(),
  });

  // Local edits override the server-derived defaults. `null` means "not edited
  // — use the server value". Keeping edits decoupled from server data avoids
  // the setState-in-effect anti-pattern.
  const [warnEdit, setWarnEdit] = React.useState<NumInput | null>(null);
  const [critEdit, setCritEdit] = React.useState<NumInput | null>(null);
  const [leadEdit, setLeadEdit] = React.useState<NumInput | null>(null);
  const [validationError, setValidationError] = React.useState<string | null>(null);

  const initialWarn = settingsQuery.data
    ? Math.round(settingsQuery.data.warnThreshold * 100)
    : null;
  const initialCrit = settingsQuery.data
    ? Math.round(settingsQuery.data.critThreshold * 100)
    : null;
  const initialLead = settingsQuery.data?.procurementLeadTimeWeeks ?? null;

  const warnPct: NumInput = warnEdit ?? initialWarn ?? '';
  const critPct: NumInput = critEdit ?? initialCrit ?? '';
  const leadWeeks: NumInput = leadEdit ?? initialLead ?? '';

  const mutation = useMutation({
    mutationFn: (input: {
      warnThreshold: number;
      critThreshold: number;
      procurementLeadTimeWeeks: number;
    }) => api.settings.tenant.update(input),
    onSuccess: (data) => {
      queryClient.setQueryData(['tenant-settings'], data);
      void queryClient.invalidateQueries({ queryKey: ['forecast'] });
      void queryClient.invalidateQueries({ queryKey: ['cluster-settings'] });
      // After save succeeds the server values now match; clear local edits so
      // the dirty check resets.
      setWarnEdit(null);
      setCritEdit(null);
      setLeadEdit(null);
    },
    onError: (err) => toast.error(describeApiError(err, 'Could not save settings')),
  });

  const dirty =
    typeof warnPct === 'number' &&
    typeof critPct === 'number' &&
    typeof leadWeeks === 'number' &&
    initialWarn !== null &&
    initialCrit !== null &&
    initialLead !== null &&
    (warnPct !== initialWarn || critPct !== initialCrit || leadWeeks !== initialLead);

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    setValidationError(null);
    if (typeof warnPct !== 'number' || typeof critPct !== 'number') return;
    if (typeof leadWeeks !== 'number') return;
    if (warnPct >= critPct) {
      setValidationError('Warn must be less than crit.');
      return;
    }
    if (warnPct < 1 || warnPct > 99 || critPct < 1 || critPct > 99) {
      setValidationError('Thresholds must be between 1% and 99%.');
      return;
    }
    if (!Number.isInteger(leadWeeks) || leadWeeks < 0 || leadWeeks > 104) {
      setValidationError('Procurement lead time must be a whole number from 0 to 104 weeks.');
      return;
    }
    mutation.mutate({
      warnThreshold: warnPct / 100,
      critThreshold: critPct / 100,
      procurementLeadTimeWeeks: leadWeeks,
    });
  };

  const parseInput = (raw: string): NumInput => (raw === '' ? '' : Number(raw));

  return (
    <Card className="p-4">
      <header className="mb-4">
        <h2 className="text-base font-semibold">Forecast thresholds</h2>
        <p className="text-sm text-fg-muted">
          Default warn/crit bands. Per-cluster overrides apply on the cluster's Settings tab.
        </p>
      </header>
      <form onSubmit={handleSubmit} className="space-y-3" noValidate>
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
        <label className="block">
          <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-subtle">
            Procurement lead time (weeks)
          </span>
          <Input
            type="number"
            min={0}
            max={104}
            step={1}
            aria-label="Procurement lead time (weeks)"
            value={leadWeeks}
            onChange={(e) => setLeadEdit(parseInput(e.target.value))}
            className="mt-1"
          />
          <span className="mt-1 block text-[11px] text-fg-subtle">
            How long from PO to racked + in-service. Set to 0 to hide the lead-time KPI.
          </span>
        </label>
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
