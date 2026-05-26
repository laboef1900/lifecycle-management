import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { ScenarioWire } from '@/lib/api-client';

type ScenarioKind = 'lose_hosts' | 'add_vms' | 'delay_procurement';

interface ScenarioControlsProps {
  active: ScenarioWire | null;
  onChange: (scenario: ScenarioWire | null) => void;
}

interface DraftState {
  kind: ScenarioKind;
  loseCount: string;
  addCount: string;
  addSize: string;
  delayMonths: string;
}

const DEFAULT_DRAFT: DraftState = {
  kind: 'lose_hosts',
  loseCount: '1',
  addCount: '20',
  addSize: '16',
  delayMonths: '2',
};

function draftToScenario(d: DraftState): { scenario: ScenarioWire | null; error: string | null } {
  switch (d.kind) {
    case 'lose_hosts': {
      const n = Number(d.loseCount);
      if (!Number.isInteger(n) || n < 1) return { scenario: null, error: 'Count must be ≥ 1.' };
      return { scenario: { kind: 'lose_hosts', count: n }, error: null };
    }
    case 'add_vms': {
      const c = Number(d.addCount);
      const s = Number(d.addSize);
      if (!Number.isInteger(c) || c < 1) return { scenario: null, error: 'Count must be ≥ 1.' };
      if (!(s > 0)) return { scenario: null, error: 'Size must be > 0 GB.' };
      return { scenario: { kind: 'add_vms', count: c, sizeGb: s }, error: null };
    }
    case 'delay_procurement': {
      const m = Number(d.delayMonths);
      if (!Number.isInteger(m) || m < 1) return { scenario: null, error: 'Months must be ≥ 1.' };
      return { scenario: { kind: 'delay_procurement', months: m }, error: null };
    }
  }
}

export function ScenarioControls({ active, onChange }: ScenarioControlsProps): React.JSX.Element {
  const [draft, setDraft] = React.useState<DraftState>(DEFAULT_DRAFT);
  const [error, setError] = React.useState<string | null>(null);

  const updateDraft = (patch: Partial<DraftState>): void => {
    setDraft((d) => ({ ...d, ...patch }));
  };

  const apply = (): void => {
    const r = draftToScenario(draft);
    if (r.error) {
      setError(r.error);
      return;
    }
    setError(null);
    onChange(r.scenario);
  };

  const clear = (): void => {
    setError(null);
    onChange(null);
  };

  return (
    <section
      data-testid="scenario-controls"
      aria-label="Forecast scenarios"
      className="rounded-[var(--radius-card)] border border-border bg-card p-3"
    >
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-subtle">
          Scenario
        </h3>
        {active ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={clear}
            data-testid="scenario-clear"
          >
            Clear
          </Button>
        ) : null}
      </div>
      <div className="grid grid-cols-12 items-end gap-2">
        <label className="col-span-12 sm:col-span-4">
          <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-subtle">
            Type
          </span>
          <Select
            value={draft.kind}
            onValueChange={(v) => updateDraft({ kind: v as ScenarioKind })}
          >
            <SelectTrigger className="mt-1" aria-label="Scenario type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="lose_hosts">Lose hosts</SelectItem>
              <SelectItem value="add_vms">Add VMs</SelectItem>
              <SelectItem value="delay_procurement">Delay procurement</SelectItem>
            </SelectContent>
          </Select>
        </label>

        {draft.kind === 'lose_hosts' ? (
          <label className="col-span-12 sm:col-span-4">
            <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-subtle">
              Hosts to drop
            </span>
            <Input
              type="number"
              min={1}
              step={1}
              aria-label="Hosts to drop"
              value={draft.loseCount}
              onChange={(e) => updateDraft({ loseCount: e.target.value })}
              className="mt-1"
            />
          </label>
        ) : null}

        {draft.kind === 'add_vms' ? (
          <>
            <label className="col-span-6 sm:col-span-2">
              <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-subtle">
                VM count
              </span>
              <Input
                type="number"
                min={1}
                step={1}
                aria-label="VM count"
                value={draft.addCount}
                onChange={(e) => updateDraft({ addCount: e.target.value })}
                className="mt-1"
              />
            </label>
            <label className="col-span-6 sm:col-span-2">
              <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-subtle">
                Size (GB)
              </span>
              <Input
                type="number"
                min={1}
                step={1}
                aria-label="Size (GB)"
                value={draft.addSize}
                onChange={(e) => updateDraft({ addSize: e.target.value })}
                className="mt-1"
              />
            </label>
          </>
        ) : null}

        {draft.kind === 'delay_procurement' ? (
          <label className="col-span-12 sm:col-span-4">
            <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-subtle">
              Delay (months)
            </span>
            <Input
              type="number"
              min={1}
              step={1}
              aria-label="Delay (months)"
              value={draft.delayMonths}
              onChange={(e) => updateDraft({ delayMonths: e.target.value })}
              className="mt-1"
            />
          </label>
        ) : null}

        <div className="col-span-12 flex items-center gap-2 sm:col-span-4 sm:justify-end">
          <Button type="button" variant="accent" size="sm" onClick={apply}>
            Apply
          </Button>
        </div>
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {active ? (
        <p className="mt-2 text-[11px] text-fg-muted" data-testid="scenario-summary">
          Active: {describeScenario(active)}
        </p>
      ) : null}
    </section>
  );
}

export function describeScenario(s: ScenarioWire): string {
  switch (s.kind) {
    case 'lose_hosts':
      return `Lose ${s.count} host${s.count === 1 ? '' : 's'}`;
    case 'add_vms':
      return `Add ${s.count} × ${s.sizeGb} GB VMs`;
    case 'delay_procurement':
      return `Delay procurement by ${s.months} mo`;
  }
}
