import * as React from 'react';

import { Slider } from '@/components/ui/slider';
import { cn } from '@/lib/utils';
import type { ScenarioWire } from '@/lib/api-client';

type ScenarioKind = 'lose_hosts' | 'add_vms' | 'delay_procurement';

interface ScenarioControlsProps {
  active: ScenarioWire | null;
  onChange: (scenario: ScenarioWire | null) => void;
  /** Cluster's tracked-host count — bounds the "lose hosts" slider. */
  maxHosts?: number | undefined;
}

interface DraftState {
  loseCount: number;
  addCount: number;
  addSize: number;
  delayMonths: number;
}

const DEFAULT_DRAFT: DraftState = { loseCount: 1, addCount: 20, addSize: 16, delayMonths: 2 };

const MAX_VMS = 100;
const MAX_DELAY_MONTHS = 24;
/** Standard VM RAM tiers — a what-if approximation, not free entry (#—). */
const SIZE_TIERS = [8, 16, 32, 64] as const;
/** Debounce for slider-driven live updates so a drag isn't one POST per pixel. */
const LIVE_DEBOUNCE_MS = 200;

const PRESETS: { kind: ScenarioKind; label: string }[] = [
  { kind: 'lose_hosts', label: 'Lose hosts' },
  { kind: 'add_vms', label: 'Add load' },
  { kind: 'delay_procurement', label: 'Delay order' },
];

const MICRO_LABEL = 'text-[10px] font-medium uppercase tracking-[0.12em] text-fg-subtle';

/** Seed the draft from whatever scenario is already applied (pane remounts on open). */
function scenarioToDraft(active: ScenarioWire | null): DraftState {
  if (!active) return DEFAULT_DRAFT;
  switch (active.kind) {
    case 'lose_hosts':
      return { ...DEFAULT_DRAFT, loseCount: active.count };
    case 'add_vms':
      return { ...DEFAULT_DRAFT, addCount: active.count, addSize: active.sizeGb };
    case 'delay_procurement':
      return { ...DEFAULT_DRAFT, delayMonths: active.months };
  }
}

function buildScenario(kind: ScenarioKind, d: DraftState): ScenarioWire {
  switch (kind) {
    case 'lose_hosts':
      return { kind: 'lose_hosts', count: d.loseCount };
    case 'add_vms':
      return { kind: 'add_vms', count: d.addCount, sizeGb: d.addSize };
    case 'delay_procurement':
      return { kind: 'delay_procurement', months: d.delayMonths };
  }
}

/**
 * Scenario "presets + live sliders". A row of preset chips selects the active
 * what-if; the tuning sliders below redraw the forecast LIVE (debounced) as you
 * drag — no Apply step. Bounded sliders make an invalid value unreachable, so
 * the old free-number-input error path is gone. Selecting the active preset
 * again returns to the baseline forecast.
 *
 * Single scenario for now; stacking several into one compound what-if is the
 * tracked follow-up (needs a composable Scenario contract server-side).
 *
 * Renders inside the cluster panel's one sanctioned glass card
 * (`ScenarioPaneBody`), which owns the surface, border, and "Scenario" heading.
 */
export function ScenarioControls({
  active,
  onChange,
  maxHosts = 8,
}: ScenarioControlsProps): React.JSX.Element {
  // Initializers, not sync effects: the draft is the user's in-progress edit
  // and must not be clobbered mid-drag. A reopened pane is a fresh mount, which
  // is exactly when re-seeding from the applied scenario is wanted.
  const [kind, setKind] = React.useState<ScenarioKind | null>(active?.kind ?? null);
  const [draft, setDraft] = React.useState<DraftState>(() => scenarioToDraft(active));
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  React.useEffect(() => () => clearTimeout(timer.current), []);

  const emit = React.useCallback(
    (nextKind: ScenarioKind | null, nextDraft: DraftState, immediate: boolean): void => {
      clearTimeout(timer.current);
      const run = (): void => onChange(nextKind ? buildScenario(nextKind, nextDraft) : null);
      if (immediate) run();
      else timer.current = setTimeout(run, LIVE_DEBOUNCE_MS);
    },
    [onChange],
  );

  const selectPreset = (next: ScenarioKind): void => {
    const nextKind = next === kind ? null : next; // re-tap the active preset → baseline
    setKind(nextKind);
    emit(nextKind, draft, true); // type change is immediate, not debounced
  };

  const patch = (p: Partial<DraftState>, immediate = false): void => {
    const next = { ...draft, ...p };
    setDraft(next);
    if (kind) emit(kind, next, immediate);
  };

  const maxLose = Math.max(1, maxHosts);

  return (
    <section data-testid="scenario-controls" aria-label="Forecast scenarios" className="space-y-3">
      <div role="group" aria-label="Scenario type" className="grid grid-cols-3 gap-1.5">
        {PRESETS.map((p) => {
          const isActive = p.kind === kind;
          return (
            <button
              key={p.kind}
              type="button"
              aria-pressed={isActive}
              data-testid={`scenario-preset-${p.kind}`}
              onClick={() => selectPreset(p.kind)}
              className={cn(
                'rounded-[var(--radius)] border px-2 py-1.5 text-xs font-medium transition-[background,border-color,color] duration-150',
                'focus-visible:outline-none active:scale-[0.98]',
                isActive
                  ? 'border-accent bg-accent text-accent-foreground'
                  : 'border-border text-fg-muted hover:border-border-strong hover:text-foreground',
              )}
            >
              {p.label}
            </button>
          );
        })}
      </div>

      {kind === null ? (
        <p className="text-xs leading-relaxed text-fg-subtle">
          Pick a scenario to preview a what-if against the baseline forecast.
        </p>
      ) : null}

      {kind === 'lose_hosts' ? (
        <SliderRow
          label="Hosts lost"
          id="scenario-lose"
          value={draft.loseCount}
          min={1}
          max={maxLose}
          display={`${draft.loseCount}`}
          valueText={`${draft.loseCount} host${draft.loseCount === 1 ? '' : 's'}`}
          onValueChange={(v) => patch({ loseCount: v })}
        />
      ) : null}

      {kind === 'add_vms' ? (
        <div className="space-y-3">
          <SliderRow
            label="VM count"
            id="scenario-vmcount"
            value={draft.addCount}
            min={1}
            max={MAX_VMS}
            display={`${draft.addCount}`}
            valueText={`${draft.addCount} VMs`}
            onValueChange={(v) => patch({ addCount: v })}
          />
          <div>
            <span className={MICRO_LABEL}>VM size</span>
            <div role="group" aria-label="VM size (GB)" className="mt-1.5 grid grid-cols-4 gap-1.5">
              {SIZE_TIERS.map((gb) => {
                const isSel = draft.addSize === gb;
                return (
                  <button
                    key={gb}
                    type="button"
                    aria-pressed={isSel}
                    data-testid={`scenario-size-${gb}`}
                    onClick={() => patch({ addSize: gb }, true)}
                    className={cn(
                      'rounded-[var(--radius)] border py-1 font-mono text-xs tabular-nums transition-colors duration-150 active:scale-[0.98]',
                      isSel
                        ? 'border-accent bg-accent text-accent-foreground'
                        : 'border-border text-fg-muted hover:border-border-strong hover:text-foreground',
                    )}
                  >
                    {gb}
                  </button>
                );
              })}
            </div>
          </div>
          <p
            className="font-mono text-[11px] tabular-nums text-fg-muted"
            data-testid="scenario-total"
          >
            = {draft.addCount * draft.addSize} GB added
          </p>
        </div>
      ) : null}

      {kind === 'delay_procurement' ? (
        <SliderRow
          label="Delay (months)"
          id="scenario-delay"
          value={draft.delayMonths}
          min={1}
          max={MAX_DELAY_MONTHS}
          display={`${draft.delayMonths} mo`}
          valueText={`${draft.delayMonths} month${draft.delayMonths === 1 ? '' : 's'}`}
          onValueChange={(v) => patch({ delayMonths: v })}
        />
      ) : null}

      {active ? (
        <p className="text-[11px] text-fg-muted" data-testid="scenario-summary">
          Active: {describeScenario(active)}
        </p>
      ) : null}
    </section>
  );
}

/** Label + live mono value + steel slider — the one tuning row shape. */
function SliderRow({
  label,
  id,
  value,
  min,
  max,
  display,
  valueText,
  onValueChange,
}: {
  label: string;
  id: string;
  value: number;
  min: number;
  max: number;
  display: string;
  valueText: string;
  onValueChange: (value: number) => void;
}): React.JSX.Element {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className={MICRO_LABEL}>
          {label}
        </label>
        <span className="font-mono text-sm font-medium tabular-nums text-foreground">
          {display}
        </span>
      </div>
      <Slider
        id={id}
        className="mt-2"
        value={value}
        min={min}
        max={max}
        aria-label={label}
        aria-valuetext={valueText}
        onValueChange={onValueChange}
      />
    </div>
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
