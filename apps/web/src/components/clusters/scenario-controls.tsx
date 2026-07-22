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

/**
 * Inverse of `draftToScenario`: seeds the form from the scenario that is
 * already applied. The pane unmounts on close (#226), so without this a reopen
 * showed the `lose_hosts` defaults next to "Active: Delay procurement by 6 mo"
 * and a single Apply click silently replaced the applied scenario with
 * "Lose 1 host" — forecast scenarios drive purchasing decisions, so the form
 * must show what is actually in effect.
 */
export function scenarioToDraft(active: ScenarioWire | null): DraftState {
  if (!active) return DEFAULT_DRAFT;
  switch (active.kind) {
    case 'lose_hosts':
      return { ...DEFAULT_DRAFT, kind: 'lose_hosts', loseCount: String(active.count) };
    case 'add_vms':
      return {
        ...DEFAULT_DRAFT,
        kind: 'add_vms',
        addCount: String(active.count),
        addSize: String(active.sizeGb),
      };
    case 'delay_procurement':
      return { ...DEFAULT_DRAFT, kind: 'delay_procurement', delayMonths: String(active.months) };
  }
}

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

/**
 * Scenario form. Since #226 it renders only inside the cluster panel's
 * Scenario pane, so the layout is stacked (one field per row) rather than the
 * old viewport-`sm:` twelve-column row, which squeezed the `add_vms` number
 * inputs to ~39px there. The pair of `add_vms` inputs is the one exception —
 * they still share a row.
 *
 * Since #243 the pane is a floating glass card and this form is chrome-less:
 * the card (`ScenarioPaneBody`) owns the surface, the border, and the single
 * "Scenario" heading — this component rendering its own card + h3 was exactly
 * the duplication #243 removes. The inputs keep their solid fills (`Input`'s
 * `bg-background`), so entered values never sit on the glass math.
 */
export function ScenarioControls({ active, onChange }: ScenarioControlsProps): React.JSX.Element {
  // Initializer, not a sync effect: the draft is the user's in-progress edit
  // and must not be clobbered while they type. A reopened pane is a fresh
  // mount, which is exactly when re-seeding is wanted.
  const [draft, setDraft] = React.useState<DraftState>(() => scenarioToDraft(active));
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
    <section data-testid="scenario-controls" aria-label="Forecast scenarios">
      <div data-testid="scenario-fields" className="space-y-2">
        <label className="block">
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
          <label className="block">
            {/* "Hosts lost" (#243 Part B copy item 2), not "Hosts to drop" —
                aligned with the "Lose hosts" scenario type above rather than
                a near-synonym verb for the same field. */}
            <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-subtle">
              Hosts lost
            </span>
            <Input
              type="number"
              min={1}
              step={1}
              aria-label="Hosts lost"
              value={draft.loseCount}
              onChange={(e) => updateDraft({ loseCount: e.target.value })}
              className="mt-1"
            />
          </label>
        ) : null}

        {draft.kind === 'add_vms' ? (
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
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
            <label className="block">
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
          </div>
        ) : null}

        {draft.kind === 'delay_procurement' ? (
          <label className="block">
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

        <div className="flex items-center justify-end gap-2 pt-1">
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
