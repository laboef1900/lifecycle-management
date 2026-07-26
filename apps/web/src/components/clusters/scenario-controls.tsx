import * as React from 'react';

import { Slider } from '@/components/ui/slider';
import { cn } from '@/lib/utils';
import type { ScenarioWire } from '@/lib/api-client';

export type ScenarioKind = 'lose_hosts' | 'add_vms' | 'delay_procurement';

/**
 * Presets that cannot move THIS cluster's forecast, each mapped to the reason
 * why — computed from the baseline forecast by the panel (`deriveBlockedPresets`)
 * and stated on the control itself. A preset that can only ever return the
 * baseline is worse than useless: applying it renders an unchanged, healthy-
 * looking forecast that reads as "the what-if is fine", which is the confident
 * wrong answer this product exists to refuse.
 */
export type BlockedPresets = Partial<Record<ScenarioKind, string>>;

interface ScenarioControlsProps {
  active: ScenarioWire | null;
  onChange: (scenario: ScenarioWire | null) => void;
  /**
   * Cluster's tracked-host count — bounds the "lose hosts" slider. `undefined`
   * means the baseline forecast that carries it hasn't resolved (or failed), in
   * which case the slider is disabled rather than guessing a bound: a guessed
   * maximum is how an out-of-range count reaches the parent.
   */
  maxHosts?: number | undefined;
  /** Presets this cluster's data cannot support, with the reason for each. */
  blocked?: BlockedPresets | undefined;
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
/** Standard VM RAM tiers — a what-if approximation, not free entry. */
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

function buildScenario(kind: ScenarioKind, d: DraftState, maxLose: number): ScenarioWire {
  switch (kind) {
    case 'lose_hosts':
      // Clamped here as well as in the slider's `max`: the bound can narrow
      // under a draft that was already seeded from an applied scenario, and
      // nothing may leave this component claiming more lost hosts than exist.
      return { kind: 'lose_hosts', count: Math.min(d.loseCount, maxLose) };
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
 * Renders inside `ScenarioPaneBody`, the docked Scenario rail, which owns the
 * surface, border, and "Scenario" heading.
 */
export function ScenarioControls({
  active,
  onChange,
  maxHosts,
  blocked,
}: ScenarioControlsProps): React.JSX.Element {
  // Initializers, not sync effects: the draft is the user's in-progress edit
  // and must not be clobbered mid-drag. A reopened pane is a fresh mount, which
  // is exactly when re-seeding from the applied scenario is wanted.
  const [kind, setKind] = React.useState<ScenarioKind | null>(active?.kind ?? null);
  const [draft, setDraft] = React.useState<DraftState>(() => scenarioToDraft(active));
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingEmit = React.useRef<(() => void) | undefined>(undefined);
  const reasonIdBase = React.useId();

  /**
   * The applied preset is never gated, even if its reason later becomes true:
   * re-tapping it is also the only way to clear it, so disabling it would trap
   * the user in a scenario they can no longer leave.
   */
  const blockedReason = (candidate: ScenarioKind): string | undefined =>
    candidate === kind ? undefined : blocked?.[candidate];

  // The "lose hosts" bound. When the host count is unknown the slider is pinned
  // to its current value and disabled rather than being given an invented
  // maximum: an invented bound is exactly how a count larger than the cluster's
  // real host list reaches the parent (and the chart) while the baseline
  // forecast that carries the count is still in flight.
  const hostCountKnown = maxHosts !== undefined && maxHosts >= 1;
  const maxLose = hostCountKnown ? maxHosts : Math.max(1, draft.loseCount);
  const loseCount = Math.min(draft.loseCount, maxLose);

  // Flush on unmount, never drop. This component unmounts on two paths the user
  // does not think of as "discard": closing the rail, and the rail moving
  // between its docked (`lg`+) and inline (below `lg`) render sites when the
  // viewport crosses the breakpoint — those are different DOM parents, so React
  // remounts. Dropping a pending debounce there would silently throw away the
  // last slider movement. The parent owns the scenario state and outlives this
  // component on both paths; when it doesn't (the whole panel unmounting), the
  // resulting setState is a no-op.
  React.useEffect(
    () => () => {
      clearTimeout(timer.current);
      pendingEmit.current?.();
    },
    [],
  );

  const emit = React.useCallback(
    (nextKind: ScenarioKind | null, nextDraft: DraftState, immediate: boolean): void => {
      clearTimeout(timer.current);
      const run = (): void => {
        pendingEmit.current = undefined;
        onChange(nextKind ? buildScenario(nextKind, nextDraft, maxLose) : null);
      };
      if (immediate) {
        run();
        return;
      }
      pendingEmit.current = run;
      timer.current = setTimeout(run, LIVE_DEBOUNCE_MS);
    },
    [onChange, maxLose],
  );

  const selectPreset = (next: ScenarioKind): void => {
    if (blockedReason(next) !== undefined) return; // defense in depth; the chip is disabled
    const nextKind = next === kind ? null : next; // re-tap the active preset → baseline
    setKind(nextKind);
    emit(nextKind, draft, true); // type change is immediate, not debounced
  };

  const patch = (p: Partial<DraftState>, immediate = false): void => {
    const next = { ...draft, ...p };
    setDraft(next);
    if (kind) emit(kind, next, immediate);
  };

  return (
    // A plain div, not a labelled <section>: the rail that contains this is
    // already a landmark named "Scenario", and a nested region repeating the
    // same thing is landmark noise for screen-reader users, not structure.
    <div data-testid="scenario-controls" className="space-y-3">
      <div role="group" aria-label="Scenario type" className="grid grid-cols-3 gap-1.5">
        {PRESETS.map((p) => {
          const isActive = p.kind === kind;
          const reason = blockedReason(p.kind);
          return (
            <button
              key={p.kind}
              type="button"
              aria-pressed={isActive}
              data-testid={`scenario-preset-${p.kind}`}
              onClick={() => selectPreset(p.kind)}
              disabled={reason !== undefined}
              {...(reason !== undefined ? { 'aria-describedby': `${reasonIdBase}-${p.kind}` } : {})}
              className={cn(
                'rounded-[var(--radius)] border px-2 py-1.5 text-xs font-medium transition-[background,border-color,color] duration-150',
                // Matches the shared Button's disabled treatment (opacity-50 +
                // no pointer response) so a dead control looks the same
                // everywhere; `cursor-not-allowed` needs pointer events, so it
                // is `pointer-events-none`'s deliberate alternative here.
                'active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100',
                isActive
                  ? 'border-accent bg-accent text-accent-foreground'
                  : 'border-border text-fg-muted enabled:hover:border-border-strong enabled:hover:text-foreground',
              )}
            >
              {p.label}
            </button>
          );
        })}
      </div>

      {/* Why a preset is off, in text — dimming alone is not a reason, and a
          disabled chip that never explains itself reads as a broken control.
          Each line is its own control's `aria-describedby` target. */}
      {PRESETS.some((p) => blockedReason(p.kind) !== undefined) ? (
        <ul className="space-y-1">
          {PRESETS.map((p) => {
            const reason = blockedReason(p.kind);
            if (reason === undefined) return null;
            return (
              <li
                key={p.kind}
                id={`${reasonIdBase}-${p.kind}`}
                className="text-[11px] leading-relaxed text-fg-muted"
              >
                <span className="font-medium text-foreground">{p.label}:</span> {reason}
              </li>
            );
          })}
        </ul>
      ) : null}

      {kind === null ? (
        <p className="text-xs leading-relaxed text-fg-subtle">
          Pick a scenario to preview a what-if against the baseline forecast.
        </p>
      ) : null}

      {kind === 'lose_hosts' ? (
        <SliderRow
          label="Hosts lost"
          id="scenario-lose"
          value={loseCount}
          min={1}
          max={maxLose}
          display={`${loseCount}`}
          valueText={`${loseCount} host${loseCount === 1 ? '' : 's'}`}
          onValueChange={(v) => patch({ loseCount: v })}
          disabled={!hostCountKnown}
          hint={hostCountKnown ? undefined : 'Waiting for the forecast to report the host count.'}
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
    </div>
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
  disabled = false,
  hint,
}: {
  label: string;
  id: string;
  value: number;
  min: number;
  max: number;
  display: string;
  valueText: string;
  onValueChange: (value: number) => void;
  disabled?: boolean;
  /** Shown under the slider and wired up as its description (e.g. why it's off). */
  hint?: string | undefined;
}): React.JSX.Element {
  const hintId = `${id}-hint`;
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
        disabled={disabled}
        {...(hint ? { 'aria-describedby': hintId } : {})}
      />
      {hint ? (
        <p id={hintId} className="mt-1.5 text-[11px] text-fg-muted">
          {hint}
        </p>
      ) : null}
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
