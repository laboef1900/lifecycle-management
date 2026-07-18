import { describe, expect, it } from 'vitest';

import { deriveProcurementKpi } from './procurement-kpi';

const today = new Date('2026-05-25T12:00:00Z');

describe('deriveProcurementKpi', () => {
  it('returns "—" and ok when no breach is projected', () => {
    const r = deriveProcurementKpi(
      { leadTimeWeeks: 8, orderByDate: null, breachMonth: null },
      today,
    );
    expect(r.value).toBe('—');
    expect(r.status).toBe('ok');
    expect(r.caption).toMatch(/no projected breach/i);
  });

  it('returns unknown instead of an all-clear when procurement timing lacks capacity', () => {
    const r = deriveProcurementKpi(
      { leadTimeWeeks: 8, orderByDate: null, breachMonth: null },
      today,
      false,
    );
    expect(r.value).toBe('—');
    expect(r.status).toBe('unknown');
    expect(r.caption).toMatch(/capacity required/i);
    expect(r.caption).not.toMatch(/no projected breach/i);
  });

  it('marks an order-by date in the past as crit / overdue', () => {
    const r = deriveProcurementKpi(
      { leadTimeWeeks: 8, orderByDate: '2026-04-01', breachMonth: '2026-06-01' },
      today,
    );
    expect(r.value).toBe('2026-04-01');
    expect(r.status).toBe('crit');
    expect(r.caption).toMatch(/overdue/i);
    expect(r.caption).toContain('June 2026');
  });

  it('marks an order-by date within 28 days as warn / urgent', () => {
    const r = deriveProcurementKpi(
      { leadTimeWeeks: 4, orderByDate: '2026-06-10', breachMonth: '2026-07-01' },
      today,
    );
    expect(r.status).toBe('warn');
    expect(r.caption).toMatch(/order in 16 days/i);
  });

  it('uses singular "1 day" wording at the boundary', () => {
    const r = deriveProcurementKpi(
      { leadTimeWeeks: 8, orderByDate: '2026-05-26', breachMonth: '2026-07-21' },
      today,
    );
    expect(r.status).toBe('warn');
    expect(r.caption).toMatch(/order in 1 day for July 2026/i);
  });

  it('marks an order-by date further than 28 days as ok with lead-time context', () => {
    const r = deriveProcurementKpi(
      { leadTimeWeeks: 8, orderByDate: '2026-08-01', breachMonth: '2026-09-26' },
      today,
    );
    expect(r.status).toBe('ok');
    expect(r.value).toBe('2026-08-01');
    expect(r.caption).toMatch(/8wk lead time before September 2026/i);
  });

  it('omits the lead-time phrase when leadTimeWeeks is 0', () => {
    const r = deriveProcurementKpi(
      { leadTimeWeeks: 0, orderByDate: '2026-09-01', breachMonth: '2026-09-01' },
      today,
    );
    expect(r.status).toBe('ok');
    expect(r.caption).toMatch(/before September 2026 warn breach/i);
    expect(r.caption).not.toMatch(/0wk/);
  });

  it('boundary: today === orderByDate is still in lead-time window (0 days, warn)', () => {
    const r = deriveProcurementKpi(
      { leadTimeWeeks: 8, orderByDate: '2026-05-25', breachMonth: '2026-07-20' },
      today,
    );
    expect(r.status).toBe('warn');
    expect(r.caption).toMatch(/order in 0 days/i);
  });
});
