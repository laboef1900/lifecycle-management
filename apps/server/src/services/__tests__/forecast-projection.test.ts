import { describe, it, expect } from 'vitest';
import { computeForecast, type ForecastInput, type ForecastHost } from '../forecast.js';

const baseHost = (overrides: Partial<ForecastHost> = {}): ForecastHost => ({
  id: 'h1',
  name: 'h1',
  commissionedAt: new Date('2024-01-01'),
  decommissionedAt: null,
  projectedDecommissionAt: null,
  capacities: [{ effectiveFrom: new Date('2024-01-01'), amount: 100 }],
  ...overrides,
});

const input = (host: ForecastHost): ForecastInput => ({
  baselineDate: new Date('2026-01-01'),
  baselineConsumption: 0,
  baselineCapacity: 0,
  hosts: [host],
  applications: [],
  events: [],
});

describe('forecast projector — projectedDecommissionAt', () => {
  it('drops capacity at projectedDecommissionAt when no real decommissionedAt is set', () => {
    const f = computeForecast(
      input(baseHost({ projectedDecommissionAt: new Date('2026-06-01') })),
      new Date('2026-01-01'),
      new Date('2026-12-01'),
    );
    expect(f.months.find((m) => m.month === '2026-05-01')?.capacity).toBe(100);
    expect(f.months.find((m) => m.month === '2026-06-01')?.capacity).toBe(0);
    expect(f.months.find((m) => m.month === '2026-12-01')?.capacity).toBe(0);
  });

  it('real decommissionedAt wins if earlier than projected', () => {
    const f = computeForecast(
      input(
        baseHost({
          decommissionedAt: new Date('2026-03-01'),
          projectedDecommissionAt: new Date('2026-08-01'),
        }),
      ),
      new Date('2026-01-01'),
      new Date('2026-12-01'),
    );
    expect(f.months.find((m) => m.month === '2026-02-01')?.capacity).toBe(100);
    expect(f.months.find((m) => m.month === '2026-03-01')?.capacity).toBe(0);
  });

  it('ignores projectedDecommissionAt when it is null (unchanged behavior)', () => {
    const f = computeForecast(
      input(baseHost({ projectedDecommissionAt: null })),
      new Date('2026-01-01'),
      new Date('2026-12-01'),
    );
    expect(f.months.every((m) => m.capacity === 100)).toBe(true);
  });
});
