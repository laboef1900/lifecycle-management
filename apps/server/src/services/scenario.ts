import { addUtcMonths, compareScenarioSteps, MAX_SCENARIO_STEPS, type Scenario } from '@lcm/shared';

import type { ForecastApplication, ForecastHost, ForecastInput } from './forecast.js';

/**
 * Apply a compound what-if — an ordered fold of {@link applyScenario} over the
 * steps, sorted into the canonical order first. Returns a NEW input.
 *
 * The order itself (`SCENARIO_STEP_ORDER`) lives in `@lcm/shared` because the web
 * rail renders its rows by the same order; see the `@ai-warning` there for the
 * new-kind tripwire. The steps commute today — `lose_hosts` ranks off capacity
 * rows, `delay_procurement` moves only commissioning dates, `add_vms` touches
 * only applications — so the order is a forward-looking guarantee that the answer
 * never depends on how a client happened to serialise the steps.
 *
 * @ai-warning Do NOT expect the permutation test to catch a non-commuting kind:
 * it asserts the SORTED fold is order-independent, which it is *by construction*
 * — sorting makes the output a pure function of the step multiset. The
 * commutativity of the individual transforms is pinned separately, by folding
 * WITHOUT the sort ("the transforms themselves commute" in
 * `__tests__/scenario.test.ts`).
 *
 * The step index handed to each step comes from the SORTED order, not the
 * caller's: it seeds `add_vms`'s synthetic application id, so deriving it from
 * the received order would make the response depend on step order and break
 * permutation-invariance.
 *
 * @ai-warning The cap and uniqueness checks below are NOT redundant with the
 * route's Zod parse. INV-4 and INV-6 are stated in the design as properties of
 * the FOLD, and this function is exported, takes a bare array, and has no way to
 * know whether its caller validated. Today the preview route is the only caller
 * and it does; the second caller is the one this guards against — a duplicate
 * `add_vms` silently corrupts the response (two entries sharing one aliased
 * contributions array) rather than failing, and an unbounded array walks straight
 * into the O(months × rows) loop that `MAX_FORECAST_SPAN_MONTHS` exists to bound.
 * These throw rather than filter: a violation here is a programmer error on a
 * purchasing-critical path, and silently repairing it would hide the bug.
 */
export function applyScenarioStack(
  input: ForecastInput,
  steps: readonly Scenario[],
): ForecastInput {
  if (steps.length > MAX_SCENARIO_STEPS) {
    throw new Error(
      `applyScenarioStack: ${steps.length} steps exceeds MAX_SCENARIO_STEPS (${MAX_SCENARIO_STEPS})`,
    );
  }
  const kinds = new Set(steps.map((step) => step.kind));
  if (kinds.size !== steps.length) {
    throw new Error('applyScenarioStack: each scenario kind may appear at most once');
  }

  return [...steps]
    .sort((a, b) => compareScenarioSteps(a.kind, b.kind))
    .reduce((acc, step, index) => applyScenario(acc, step, index), input);
}

/**
 * Apply one what-if step to a forecast input, returning a NEW input. The
 * original input must not be mutated — the loader calls this on the result of
 * the same DB read it uses for the baseline forecast, and both must be safe to
 * recompute side by side.
 *
 * `stepIndex` scopes the synthetic ids a step mints so they stay unique within a
 * stack.
 *
 * @ai-warning `stepIndex` is REQUIRED, deliberately. It used to default to 0,
 * which meant a hand-rolled fold (`for (const s of steps) acc = applyScenario(acc,
 * s)`) typechecked, ran, and minted the SAME synthetic id for every step —
 * silently defeating the id-collision defence the index exists to provide. Prefer
 * {@link applyScenarioStack}; if you must fold by hand, you now have to state the
 * index and think about it.
 */
export function applyScenario(
  input: ForecastInput,
  scenario: Scenario,
  stepIndex: number,
): ForecastInput {
  switch (scenario.kind) {
    case 'lose_hosts':
      return loseLargestHosts(input, scenario.count);
    case 'add_vms':
      return addSyntheticVms(
        input,
        scenario.count,
        scenario.sizeGb,
        stepIndex,
        scenario.startMonth,
      );
    case 'delay_procurement':
      return delayFutureCommissions(input, scenario.months);
  }
}

/**
 * Drop the N hosts with the largest capacity at the start of the forecast
 * window. "Largest" uses the capacity row whose effectiveFrom <= baselineDate
 * (treating absent rows as 0).
 */
function loseLargestHosts(input: ForecastInput, count: number): ForecastInput {
  if (count <= 0) return input;
  const windowStart = input.baselineDate;
  const ranked = [...input.hosts].sort(
    (a, b) => capacityAt(b, windowStart) - capacityAt(a, windowStart),
  );
  const toDrop = new Set(ranked.slice(0, count).map((h) => h.id));
  return {
    ...input,
    hosts: input.hosts.filter((h) => !toDrop.has(h.id)),
  };
}

function capacityAt(host: ForecastHost, date: Date): number {
  let amount = 0;
  for (const row of [...host.capacities].sort(
    (a, b) => a.effectiveFrom.getTime() - b.effectiveFrom.getTime(),
  )) {
    if (row.effectiveFrom <= date) amount = row.amount;
    else break;
  }
  return amount;
}

/**
 * @ai-warning The synthetic id MUST stay unique across the steps of one stack.
 * `computeForecast` keys `applicationContributions` on a `Map<id, …>`, so two
 * applications sharing an id emit two response entries backed by the same
 * aliased array — two amounts per month under one id, while `months[]` totals
 * stay correct (the sum iterates the array, not the map). That is a wrong
 * response no total-based assertion catches. `scenarioStackSchema` already
 * rejects a duplicate `add_vms`; `stepIndex` is the second, structural defence
 * so relaxing that refine cannot silently corrupt the response.
 *
 * The user-visible `name` is deliberately NOT indexed — one `add_vms` per stack
 * means it is already unambiguous, and an index would just be noise on screen.
 */
function addSyntheticVms(
  input: ForecastInput,
  count: number,
  sizeGb: number,
  stepIndex: number,
  startMonth?: Date,
): ForecastInput {
  const startedAt = startMonth ?? new Date();
  const total = count * sizeGb;
  const synthetic: ForecastApplication = {
    id: `__scenario:${stepIndex}:add_vms:${count}x${sizeGb}`,
    name: `Scenario: +${count} × ${sizeGb} GB`,
    startedAt,
    endedAt: null,
    allocations: [{ effectiveFrom: startedAt, amount: total }],
  };
  return {
    ...input,
    applications: [...input.applications, synthetic],
  };
}

/**
 * Shift every future commissionedAt and projectedDecommissionAt by N calendar
 * months (UTC, month-end clamped). Past commissions are untouched: those hosts
 * are already deployed. v1 is uniform across all hosts — per-host targeting is
 * deferred. Events are intentionally NOT shifted: they model demand/capacity
 * changes that happen regardless of procurement timing.
 */
function delayFutureCommissions(input: ForecastInput, months: number): ForecastInput {
  if (months <= 0) return input;
  const now = new Date();
  return {
    ...input,
    hosts: input.hosts.map((host) => {
      if (host.commissionedAt <= now) return host;
      return {
        ...host,
        commissionedAt: addUtcMonths(host.commissionedAt, months),
        projectedDecommissionAt: host.projectedDecommissionAt
          ? addUtcMonths(host.projectedDecommissionAt, months)
          : host.projectedDecommissionAt,
      };
    }),
  };
}
