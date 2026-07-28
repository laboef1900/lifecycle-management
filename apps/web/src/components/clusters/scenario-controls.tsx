import * as React from 'react';
import { X } from 'lucide-react';

import { MAX_SCENARIO_STEPS } from '@lcm/shared';

import { Button } from '@/components/ui/button';
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
  /**
   * The active stack, in the order the user built it. Empty means "baseline".
   *
   * @ai-warning An empty array is falsy-adjacent but truthy in JS — never write
   * `active ? …`. Every consumer must test `active.length > 0`.
   */
  active: readonly ScenarioWire[];
  onChange: (steps: ScenarioWire[]) => void;
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

/**
 * Canonical step order, mirroring the server's fold (`STEP_ORDER` in
 * `apps/server/src/services/scenario.ts`). Rows render in this order rather than
 * the order the user happened to tap, so the rail reads the same way every time
 * for the same stack — and matches the order the summary text lists them in.
 */
const KIND_ORDER: Record<ScenarioKind, number> = {
  lose_hosts: 0,
  add_vms: 1,
  delay_procurement: 2,
};

const orderKinds = (kinds: readonly ScenarioKind[]): ScenarioKind[] =>
  [...kinds].sort((a, b) => KIND_ORDER[a] - KIND_ORDER[b]);

const MICRO_LABEL = 'text-[10px] font-medium uppercase tracking-[0.12em] text-fg-subtle';

/** Seed the draft from whatever stack is already applied (pane remounts on open). */
function scenarioToDraft(active: readonly ScenarioWire[]): DraftState {
  return active.reduce<DraftState>((draft, step) => {
    switch (step.kind) {
      case 'lose_hosts':
        return { ...draft, loseCount: step.count };
      case 'add_vms':
        return { ...draft, addCount: step.count, addSize: step.sizeGb };
      case 'delay_procurement':
        return { ...draft, delayMonths: step.months };
    }
  }, DEFAULT_DRAFT);
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

/** Derived from PRESETS, not re-listed: the chip and its stack row must never
 *  drift apart in wording — the row header is how a user identifies which chip
 *  produced it. */
const PRESET_LABEL = Object.fromEntries(PRESETS.map((p) => [p.kind, p.label])) as Record<
  ScenarioKind,
  string
>;

/**
 * Scenario "presets + live sliders", stackable (#323). The preset chips toggle
 * steps into and out of a compound what-if of up to {@link MAX_SCENARIO_STEPS}
 * steps; each step in the stack gets its own tuning row, which redraws the
 * forecast LIVE (debounced) as you drag — no Apply step. Bounded sliders make an
 * invalid value unreachable, so the old free-number-input error path is gone.
 *
 * Two ways out of a step, deliberately: re-tap its chip, or use the row's own
 * Remove control. The chip toggle is what keeps a blocked-but-applied step
 * escapable (see `blockedReason`); the row control is what makes removal
 * discoverable once several steps are stacked and the chips no longer read as
 * "the current one".
 *
 * Renders inside `ScenarioPaneBody`, the docked Scenario rail, which owns the
 * surface, border, scrolling, and "Scenario" heading.
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
  const [kinds, setKinds] = React.useState<ScenarioKind[]>(() =>
    orderKinds(active.map((s) => s.kind)),
  );
  const [draft, setDraft] = React.useState<DraftState>(() => scenarioToDraft(active));
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingEmit = React.useRef<(() => void) | undefined>(undefined);
  const reasonIdBase = React.useId();

  const atCapacity = kinds.length >= MAX_SCENARIO_STEPS;

  /**
   * A step already IN the stack is never gated, even if its reason later becomes
   * true: its chip is one of the two ways to remove it, so disabling it would
   * trap the user in a step they can no longer leave. (The row's Remove control
   * is the other way out — but both must stay live, because the chip is the only
   * one a user who learned the single-scenario UI will look for.)
   *
   * The capacity reason is separate and only reachable if a fourth kind is ever
   * added: with three kinds a full stack leaves no inactive chip to gate.
   */
  const blockedReason = (candidate: ScenarioKind): string | undefined => {
    if (kinds.includes(candidate)) return undefined;
    if (blocked?.[candidate] !== undefined) return blocked[candidate];
    return atCapacity
      ? `a scenario combines at most ${MAX_SCENARIO_STEPS} what-ifs. Remove one first.`
      : undefined;
  };

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
    (nextKinds: readonly ScenarioKind[], nextDraft: DraftState, immediate: boolean): void => {
      clearTimeout(timer.current);
      const run = (): void => {
        pendingEmit.current = undefined;
        onChange(nextKinds.map((k) => buildScenario(k, nextDraft, maxLose)));
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

  const setStack = (nextKinds: ScenarioKind[]): void => {
    setKinds(nextKinds);
    emit(nextKinds, draft, true); // adding/removing a step is immediate, not debounced
  };

  const togglePreset = (next: ScenarioKind): void => {
    if (blockedReason(next) !== undefined) return; // defense in depth; the chip is aria-disabled
    setStack(kinds.includes(next) ? kinds.filter((k) => k !== next) : orderKinds([...kinds, next]));
  };

  const removeStep = (target: ScenarioKind): void => {
    setStack(kinds.filter((k) => k !== target));
  };

  const patch = (p: Partial<DraftState>, immediate = false): void => {
    const next = { ...draft, ...p };
    setDraft(next);
    if (kinds.length > 0) emit(kinds, next, immediate);
  };

  return (
    // A plain div, not a labelled <section>: the rail that contains this is
    // already a landmark named "Scenario", and a nested region repeating the
    // same thing is landmark noise for screen-reader users, not structure.
    <div data-testid="scenario-controls" className="space-y-3">
      <div role="group" aria-label="Scenario steps" className="grid grid-cols-3 gap-1.5">
        {PRESETS.map((p) => {
          const isActive = kinds.includes(p.kind);
          const reason = blockedReason(p.kind);
          return (
            <button
              key={p.kind}
              type="button"
              aria-pressed={isActive}
              data-testid={`scenario-preset-${p.kind}`}
              onClick={() => togglePreset(p.kind)}
              // `aria-disabled`, NOT the native `disabled` attribute. Native
              // `disabled` removes the chip from the tab order, so the
              // `aria-describedby` reason below could never be announced — the
              // stated reason was reachable only as sighted text, which defeats
              // the point of stating it. Keeping the chip focusable lets a
              // screen-reader user land on it and hear why it is unavailable;
              // `togglePreset`'s early return is the actual block.
              aria-disabled={reason !== undefined}
              {...(reason !== undefined ? { 'aria-describedby': `${reasonIdBase}-${p.kind}` } : {})}
              className={cn(
                'rounded-[var(--radius)] border px-2 py-1.5 text-xs font-medium transition-[background,border-color,color] duration-150',
                // Matches the shared Button's disabled treatment (opacity-50 +
                // no pointer response) so a dead control looks the same
                // everywhere. Keyed off aria-disabled rather than :disabled
                // because the chip stays focusable — see the comment above.
                'active:scale-[0.98] aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:active:scale-100',
                isActive
                  ? 'border-accent bg-accent text-accent-foreground'
                  : reason !== undefined
                    ? 'border-border text-fg-muted'
                    : 'border-border text-fg-muted hover:border-border-strong hover:text-foreground',
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

      {kinds.length === 0 ? (
        <p className="text-xs leading-relaxed text-fg-subtle">
          Pick one or more scenarios to preview a combined what-if against the baseline forecast.
        </p>
      ) : (
        // A list, because it now genuinely is one — an ordered set of steps a
        // screen-reader user should be able to count and navigate. Hairline
        // dividers rather than nested cards: three bordered boxes inside a 340px
        // rail is chrome competing with the data.
        <ul className="divide-y divide-border" data-testid="scenario-stack">
          {kinds.map((k) => (
            <li key={k} data-testid={`scenario-step-${k}`} className="py-3 first:pt-0 last:pb-0">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className={MICRO_LABEL}>{PRESET_LABEL[k]}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="chip"
                  data-testid={`scenario-step-remove-${k}`}
                  // Names the step, not just "Remove": with up to three of these
                  // in one rail, three controls all called "Remove" is exactly
                  // the ambiguity a screen-reader user cannot resolve.
                  aria-label={`Remove ${PRESET_LABEL[k]} from the scenario`}
                  onClick={() => removeStep(k)}
                  className="text-fg-subtle hover:text-foreground"
                >
                  <X className="h-3 w-3" aria-hidden />
                  Remove
                </Button>
              </div>

              {k === 'lose_hosts' ? (
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
                  hint={
                    hostCountKnown
                      ? undefined
                      : 'Waiting for the forecast to report the host count.'
                  }
                />
              ) : null}

              {k === 'add_vms' ? (
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
                    <div
                      role="group"
                      aria-label="VM size (GB)"
                      className="mt-1.5 grid grid-cols-4 gap-1.5"
                    >
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

              {k === 'delay_procurement' ? (
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
            </li>
          ))}
        </ul>
      )}

      {active.length > 0 ? (
        <p className="text-[11px] text-fg-muted" data-testid="scenario-summary">
          Active: {describeScenarioStack(active)}
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

/**
 * One phrase for a whole compound what-if, listed in canonical step order.
 *
 * This string is load-bearing in three places at once — the header's
 * active-scenario indicator, the panel's aria-live announcements, and the chart
 * legend — so it has to read as a single sentence fragment in all three. " + "
 * is the join because the steps are simultaneous conditions, not a sequence:
 * "and then" would imply an ordering the forecast does not model.
 *
 * Returns `''` for an empty stack; callers gate on `length > 0` and must not
 * render this as a label for "no scenario".
 */
export function describeScenarioStack(steps: readonly ScenarioWire[]): string {
  return orderKinds(steps.map((s) => s.kind))
    .map((kind) => {
      const step = steps.find((s) => s.kind === kind);
      return step ? describeScenario(step) : '';
    })
    .filter((phrase) => phrase !== '')
    .join(' + ');
}
