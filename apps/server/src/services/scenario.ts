import { addUtcMonths, type Scenario } from '@lcm/shared';

import type { ForecastApplication, ForecastHost, ForecastInput } from './forecast.js';

/**
 * Apply a what-if scenario to a forecast input, returning a NEW input. The
 * original input must not be mutated — the loader calls this on the result of
 * the same DB read it uses for the baseline forecast, and both must be safe to
 * recompute side by side.
 */
export function applyScenario(input: ForecastInput, scenario: Scenario): ForecastInput {
  switch (scenario.kind) {
    case 'lose_hosts':
      return loseLargestHosts(input, scenario.count);
    case 'add_vms':
      return addSyntheticVms(input, scenario.count, scenario.sizeGb, scenario.startMonth);
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

function addSyntheticVms(
  input: ForecastInput,
  count: number,
  sizeGb: number,
  startMonth?: Date,
): ForecastInput {
  const startedAt = startMonth ?? new Date();
  const total = count * sizeGb;
  const synthetic: ForecastApplication = {
    id: `__scenario:add_vms:${count}x${sizeGb}`,
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
