import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as React from 'react';
import { toast } from 'sonner';

import type { ForecastUncertaintyBandWidth, TenantSettings } from '@lcm/shared';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { api, describeApiError } from '@/lib/api-client';

type NumInput = number | '';

const BAND_WIDTH_LABELS: Record<ForecastUncertaintyBandWidth, string> = {
  p10_p90: 'p10–p90 (widest)',
  p05_p95: 'p5–p95',
  stddev: '±1 std dev',
};
const BAND_WIDTHS = Object.keys(BAND_WIDTH_LABELS) as ForecastUncertaintyBandWidth[];

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
  const [retentionEdit, setRetentionEdit] = React.useState<NumInput | null>(null);
  const [bandEnabledEdit, setBandEnabledEdit] = React.useState<boolean | null>(null);
  const [minAnchorsEdit, setMinAnchorsEdit] = React.useState<NumInput | null>(null);
  const [bandWidthEdit, setBandWidthEdit] = React.useState<ForecastUncertaintyBandWidth | null>(
    null,
  );
  const [validationError, setValidationError] = React.useState<string | null>(null);

  const initialWarn = settingsQuery.data
    ? Math.round(settingsQuery.data.warnThreshold * 100)
    : null;
  const initialCrit = settingsQuery.data
    ? Math.round(settingsQuery.data.critThreshold * 100)
    : null;
  const initialLead = settingsQuery.data?.procurementLeadTimeWeeks ?? null;
  const initialRetention = settingsQuery.data?.idempotencyKeyRetentionHours ?? null;
  const initialBandEnabled = settingsQuery.data?.forecastUncertaintyBandEnabled ?? null;
  const initialMinAnchors = settingsQuery.data?.forecastUncertaintyMinAnchors ?? null;
  const initialBandWidth = settingsQuery.data?.forecastUncertaintyBandWidth ?? null;

  const warnPct: NumInput = warnEdit ?? initialWarn ?? '';
  const critPct: NumInput = critEdit ?? initialCrit ?? '';
  const leadWeeks: NumInput = leadEdit ?? initialLead ?? '';
  const retentionHours: NumInput = retentionEdit ?? initialRetention ?? '';
  const bandEnabled: boolean = bandEnabledEdit ?? initialBandEnabled ?? false;
  const minAnchors: NumInput = minAnchorsEdit ?? initialMinAnchors ?? '';
  const bandWidth: ForecastUncertaintyBandWidth = bandWidthEdit ?? initialBandWidth ?? 'p10_p90';

  const mutation = useMutation({
    mutationFn: (input: TenantSettings) => api.settings.tenant.update(input),
    onSuccess: (data) => {
      queryClient.setQueryData(['tenant-settings'], data);
      void queryClient.invalidateQueries({ queryKey: ['forecast'] });
      void queryClient.invalidateQueries({ queryKey: ['cluster-settings'] });
      // After save succeeds the server values now match; clear local edits so
      // the dirty check resets.
      setWarnEdit(null);
      setCritEdit(null);
      setLeadEdit(null);
      setRetentionEdit(null);
      setBandEnabledEdit(null);
      setMinAnchorsEdit(null);
      setBandWidthEdit(null);
    },
    onError: (err) => toast.error(describeApiError(err, 'Could not save settings')),
  });

  const dirty =
    typeof warnPct === 'number' &&
    typeof critPct === 'number' &&
    typeof leadWeeks === 'number' &&
    typeof retentionHours === 'number' &&
    typeof minAnchors === 'number' &&
    initialWarn !== null &&
    initialCrit !== null &&
    initialLead !== null &&
    initialRetention !== null &&
    initialBandEnabled !== null &&
    initialMinAnchors !== null &&
    initialBandWidth !== null &&
    (warnPct !== initialWarn ||
      critPct !== initialCrit ||
      leadWeeks !== initialLead ||
      retentionHours !== initialRetention ||
      bandEnabled !== initialBandEnabled ||
      minAnchors !== initialMinAnchors ||
      bandWidth !== initialBandWidth);

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    setValidationError(null);
    if (typeof warnPct !== 'number' || typeof critPct !== 'number') return;
    if (typeof leadWeeks !== 'number') return;
    if (typeof retentionHours !== 'number') return;
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
    if (!Number.isInteger(retentionHours) || retentionHours < 1 || retentionHours > 168) {
      setValidationError('Idempotency key retention must be a whole number from 1 to 168 hours.');
      return;
    }
    if (typeof minAnchors !== 'number') return;
    if (!Number.isInteger(minAnchors) || minAnchors < 3 || minAnchors > 24) {
      setValidationError('Minimum anchors must be a whole number from 3 to 24.');
      return;
    }
    mutation.mutate({
      warnThreshold: warnPct / 100,
      critThreshold: critPct / 100,
      procurementLeadTimeWeeks: leadWeeks,
      idempotencyKeyRetentionHours: retentionHours,
      forecastUncertaintyBandEnabled: bandEnabled,
      forecastUncertaintyMinAnchors: minAnchors,
      forecastUncertaintyBandWidth: bandWidth,
    });
  };

  const parseInput = (raw: string): NumInput => (raw === '' ? '' : Number(raw));

  return (
    <Card className="max-w-2xl p-4">
      <header className="mb-4">
        <h3 className="text-base font-semibold">Forecast thresholds</h3>
        <p className="text-sm text-fg-muted">
          Default warn/crit bands. Per-cluster overrides apply on each cluster&rsquo;s Cluster
          settings tab.
        </p>
      </header>
      <form onSubmit={handleSubmit} className="space-y-3" noValidate>
        {/* flex, not grid-cols-2: a percentage is 1-3 digits, so the fields hug
            their own w-24 input instead of each stretching across half the
            (now width-capped) card. */}
        <div className="flex flex-wrap gap-4">
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
              className="mt-1 w-24"
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
              className="mt-1 w-24"
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
            className="mt-1 w-24"
          />
          <span className="mt-1 block max-w-md text-[11px] text-fg-subtle">
            How long from PO to racked + in-service. Set to 0 to hide the lead-time zone on the
            fleet timeline.
          </span>
        </label>
        <label className="block">
          <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-subtle">
            Idempotency key retention (hours)
          </span>
          <Input
            type="number"
            min={1}
            max={168}
            step={1}
            aria-label="Idempotency key retention (hours)"
            value={retentionHours}
            onChange={(e) => setRetentionEdit(parseInput(e.target.value))}
            className="mt-1 w-24"
          />
          <span className="mt-1 block max-w-md text-[11px] text-fg-subtle">
            How long a bulk-shift retry key stays valid before a resubmission runs fresh. 1–168
            hours (24 default).
          </span>
        </label>
        <div className="space-y-2 rounded-md border border-border p-3">
          <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={bandEnabled}
              onChange={(e) => setBandEnabledEdit(e.target.checked)}
              className="h-3.5 w-3.5 accent-[var(--accent)]"
            />
            <span>Show forecast uncertainty band</span>
          </label>
          <p className="max-w-md text-[11px] text-fg-subtle">
            Empirical only: a band derived from how far past forecasts missed the measured actual.
            It appears on a cluster&rsquo;s forecast chart once that cluster has at least the
            minimum re-anchors below — never fabricated, off by default.
          </p>
          <div className="flex flex-wrap items-end gap-4">
            <label className="block">
              <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-subtle">
                Minimum anchors
              </span>
              <Input
                type="number"
                min={3}
                max={24}
                step={1}
                aria-label="Minimum anchors"
                value={minAnchors}
                onChange={(e) => setMinAnchorsEdit(parseInput(e.target.value))}
                disabled={!bandEnabled}
                className="mt-1 w-24"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[10px] font-medium uppercase tracking-[0.12em] text-fg-subtle">
                Band width
              </span>
              <Select
                value={bandWidth}
                onValueChange={(v) => setBandWidthEdit(v as ForecastUncertaintyBandWidth)}
                disabled={!bandEnabled}
              >
                <SelectTrigger aria-label="Band width" className="h-8 w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="start">
                  {BAND_WIDTHS.map((w) => (
                    <SelectItem key={w} value={w}>
                      {BAND_WIDTH_LABELS[w]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          </div>
        </div>
        {validationError ? (
          <p className="text-sm text-destructive" role="alert">
            {validationError}
          </p>
        ) : null}
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-fg-subtle">
            {settingsQuery.data ? 'Source: Saved settings' : 'Source: System defaults'}
          </span>
          <Button type="submit" variant="accent" size="sm" disabled={!dirty || mutation.isPending}>
            {mutation.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </form>
    </Card>
  );
}
