import type { EffectiveThresholds, EventCategory } from '@lcm/shared';

import { formatDate } from '../lib/dates.js';

export interface ForecastCapacityRow {
  effectiveFrom: Date;
  amount: number;
}

export interface ForecastHost {
  id: string;
  name: string;
  commissionedAt: Date;
  decommissionedAt: Date | null;
  projectedDecommissionAt: Date | null;
  capacities: ForecastCapacityRow[];
}

export interface ForecastApplication {
  id: string;
  name: string;
  startedAt: Date;
  endedAt: Date | null;
  allocations: ForecastCapacityRow[];
}

export interface ForecastEvent {
  id: string;
  effectiveDate: Date;
  category: EventCategory;
  title: string;
  description: string | null;
  consumptionDelta: number | null;
  capacityDelta: number | null;
}

export interface ForecastInput {
  baselineDate: Date;
  baselineConsumption: number;
  baselineCapacity: number;
  hosts: ForecastHost[];
  applications: ForecastApplication[];
  events: ForecastEvent[];
}

export interface MonthlyPoint {
  month: string;
  consumption: number;
  capacity: number;
  utilization: number;
}

export interface ForecastEventOutput {
  id: string;
  effectiveDate: string;
  category: EventCategory;
  title: string;
  description: string | null;
  consumptionDelta: number | null;
  capacityDelta: number | null;
}

export interface ForecastEntityContribution {
  id: string;
  name: string;
  contributions: Array<{ month: string; amount: number }>;
}

export interface ForecastResult {
  fromMonth: string;
  toMonth: string;
  months: MonthlyPoint[];
  events: ForecastEventOutput[];
  hosts: ForecastEntityContribution[];
  applications: ForecastEntityContribution[];
  effectiveThresholds: EffectiveThresholds;
}

export type ComputedForecast = Omit<ForecastResult, 'effectiveThresholds'>;

export function computeForecast(
  input: ForecastInput,
  fromMonth: Date,
  toMonth: Date,
): ComputedForecast {
  if (toMonth < fromMonth) {
    throw new Error('toMonth must be on or after fromMonth');
  }

  const hosts = input.hosts.map((host) => ({
    ...host,
    capacities: [...host.capacities].sort(
      (a, b) => a.effectiveFrom.getTime() - b.effectiveFrom.getTime(),
    ),
  }));
  const applications = input.applications.map((app) => ({
    ...app,
    allocations: [...app.allocations].sort(
      (a, b) => a.effectiveFrom.getTime() - b.effectiveFrom.getTime(),
    ),
  }));
  const events = [...input.events].sort(
    (a, b) => a.effectiveDate.getTime() - b.effectiveDate.getTime(),
  );

  const months: MonthlyPoint[] = [];
  const hostContributions = new Map<string, Array<{ month: string; amount: number }>>();
  const applicationContributions = new Map<string, Array<{ month: string; amount: number }>>();

  for (const host of hosts) hostContributions.set(host.id, []);
  for (const app of applications) applicationContributions.set(app.id, []);

  for (const date of monthRange(fromMonth, toMonth)) {
    const monthLabel = formatDate(date);
    let capacity = input.baselineCapacity;
    let consumption = input.baselineConsumption;

    for (const host of hosts) {
      const amount = effectiveCapacityAt(host, date);
      capacity += amount;
      hostContributions.get(host.id)?.push({ month: monthLabel, amount });
    }

    for (const app of applications) {
      const amount = effectiveAllocationAt(app, date);
      consumption += amount;
      applicationContributions.get(app.id)?.push({ month: monthLabel, amount });
    }

    for (const event of events) {
      if (event.effectiveDate > date) break;
      if (event.capacityDelta !== null) capacity += event.capacityDelta;
      if (event.consumptionDelta !== null) consumption += event.consumptionDelta;
    }

    const utilization = capacity === 0 ? 0 : consumption / capacity;

    months.push({ month: monthLabel, consumption, capacity, utilization });
  }

  const eventOutputs: ForecastEventOutput[] = events
    .filter((e) => e.effectiveDate >= fromMonth && e.effectiveDate <= toMonth)
    .map((e) => ({
      id: e.id,
      effectiveDate: formatDate(e.effectiveDate),
      category: e.category,
      title: e.title,
      description: e.description,
      consumptionDelta: e.consumptionDelta,
      capacityDelta: e.capacityDelta,
    }));

  return {
    fromMonth: formatDate(fromMonth),
    toMonth: formatDate(toMonth),
    months,
    events: eventOutputs,
    hosts: hosts.map((host) => ({
      id: host.id,
      name: host.name,
      contributions: hostContributions.get(host.id) ?? [],
    })),
    applications: applications.map((app) => ({
      id: app.id,
      name: app.name,
      contributions: applicationContributions.get(app.id) ?? [],
    })),
  };
}

function effectiveCapacityAt(host: ForecastHost, date: Date): number {
  if (date < host.commissionedAt) return 0;
  const realDecom = host.decommissionedAt;
  const projDecom = host.projectedDecommissionAt;
  const effective =
    realDecom && projDecom
      ? realDecom < projDecom
        ? realDecom
        : projDecom
      : (realDecom ?? projDecom);
  if (effective !== null && date >= effective) return 0;
  let amount = 0;
  for (const row of host.capacities) {
    if (row.effectiveFrom <= date) amount = row.amount;
    else break;
  }
  return amount;
}

function effectiveAllocationAt(app: ForecastApplication, date: Date): number {
  if (date < app.startedAt) return 0;
  if (app.endedAt !== null && date >= app.endedAt) return 0;
  let amount = 0;
  for (const row of app.allocations) {
    if (row.effectiveFrom <= date) amount = row.amount;
    else break;
  }
  return amount;
}

function* monthRange(from: Date, to: Date): Iterable<Date> {
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1, 0, 0, 0, 0));
  while (cursor <= end) {
    yield new Date(cursor);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
}
