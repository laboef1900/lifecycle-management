import { describe, expect, it } from 'vitest';

import { forecastQuerySchema, MAX_FORECAST_SPAN_MONTHS } from '../forecast.js';

describe('forecastQuerySchema range bounds', () => {
  it('rejects from > to', () => {
    const r = forecastQuerySchema.safeParse({
      metric: 'memory_gb',
      from: '2027-01',
      to: '2026-01',
    });
    expect(r.success).toBe(false);
  });
  it('rejects spans over MAX_FORECAST_SPAN_MONTHS', () => {
    const r = forecastQuerySchema.safeParse({
      metric: 'memory_gb',
      from: '2026-01',
      to: '2999-12',
    });
    expect(r.success).toBe(false);
  });
  it('accepts a 24-month window', () => {
    const r = forecastQuerySchema.safeParse({
      metric: 'memory_gb',
      from: '2026-01',
      to: '2027-12',
    });
    expect(r.success).toBe(true);
  });
  it('still accepts omitted bounds', () => {
    expect(forecastQuerySchema.safeParse({ metric: 'memory_gb' }).success).toBe(true);
  });
  it('exports a 120-month cap', () => {
    expect(MAX_FORECAST_SPAN_MONTHS).toBe(120);
  });
});
