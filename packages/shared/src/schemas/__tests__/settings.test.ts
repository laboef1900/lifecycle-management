import { describe, expect, it } from 'vitest';

import {
  clusterSettingsInputSchema,
  effectiveThresholdsSchema,
  percentSchema,
  tenantSettingsSchema,
} from '../settings.js';

describe('percentSchema', () => {
  it('accepts 0.01 to 0.99', () => {
    expect(percentSchema.parse(0.01)).toBe(0.01);
    expect(percentSchema.parse(0.99)).toBe(0.99);
  });

  it('rejects values outside 0.01..0.99', () => {
    expect(() => percentSchema.parse(0)).toThrow();
    expect(() => percentSchema.parse(1)).toThrow();
    expect(() => percentSchema.parse(-0.1)).toThrow();
  });
});

describe('tenantSettingsSchema', () => {
  it('accepts warn < crit', () => {
    expect(
      tenantSettingsSchema.parse({
        warnThreshold: 0.7,
        critThreshold: 0.9,
        procurementLeadTimeWeeks: 8,
        idempotencyKeyRetentionHours: 24,
        forecastUncertaintyBandEnabled: false,
        forecastUncertaintyMinAnchors: 6,
        forecastUncertaintyBandWidth: 'p10_p90',
      }),
    ).toEqual({
      warnThreshold: 0.7,
      critThreshold: 0.9,
      procurementLeadTimeWeeks: 8,
      idempotencyKeyRetentionHours: 24,
      forecastUncertaintyBandEnabled: false,
      forecastUncertaintyMinAnchors: 6,
      forecastUncertaintyBandWidth: 'p10_p90',
    });
  });

  it('rejects warn === crit', () => {
    expect(() =>
      tenantSettingsSchema.parse({
        warnThreshold: 0.8,
        critThreshold: 0.8,
        procurementLeadTimeWeeks: 8,
        idempotencyKeyRetentionHours: 24,
      }),
    ).toThrow();
  });

  it('rejects warn > crit', () => {
    expect(() =>
      tenantSettingsSchema.parse({
        warnThreshold: 0.9,
        critThreshold: 0.7,
        procurementLeadTimeWeeks: 8,
        idempotencyKeyRetentionHours: 24,
      }),
    ).toThrow();
  });

  it('rejects missing procurementLeadTimeWeeks', () => {
    expect(() => tenantSettingsSchema.parse({ warnThreshold: 0.7, critThreshold: 0.9 })).toThrow();
  });

  it('rejects procurementLeadTimeWeeks outside 0..104', () => {
    expect(() =>
      tenantSettingsSchema.parse({
        warnThreshold: 0.7,
        critThreshold: 0.9,
        procurementLeadTimeWeeks: 105,
        idempotencyKeyRetentionHours: 24,
      }),
    ).toThrow();
    expect(() =>
      tenantSettingsSchema.parse({
        warnThreshold: 0.7,
        critThreshold: 0.9,
        procurementLeadTimeWeeks: -1,
        idempotencyKeyRetentionHours: 24,
      }),
    ).toThrow();
  });
});

describe('tenantSettingsSchema — idempotencyKeyRetentionHours', () => {
  const base = {
    warnThreshold: 0.7,
    critThreshold: 0.9,
    procurementLeadTimeWeeks: 8,
    forecastUncertaintyBandEnabled: false,
    forecastUncertaintyMinAnchors: 6,
    forecastUncertaintyBandWidth: 'p10_p90',
  };

  it('accepts the default of 24', () => {
    expect(tenantSettingsSchema.parse({ ...base, idempotencyKeyRetentionHours: 24 })).toMatchObject(
      { idempotencyKeyRetentionHours: 24 },
    );
  });

  it('accepts the 1 and 168 boundaries', () => {
    expect(tenantSettingsSchema.parse({ ...base, idempotencyKeyRetentionHours: 1 })).toMatchObject({
      idempotencyKeyRetentionHours: 1,
    });
    expect(
      tenantSettingsSchema.parse({ ...base, idempotencyKeyRetentionHours: 168 }),
    ).toMatchObject({ idempotencyKeyRetentionHours: 168 });
  });

  it('rejects 0 and 169', () => {
    expect(() =>
      tenantSettingsSchema.parse({ ...base, idempotencyKeyRetentionHours: 0 }),
    ).toThrow();
    expect(() =>
      tenantSettingsSchema.parse({ ...base, idempotencyKeyRetentionHours: 169 }),
    ).toThrow();
  });

  it('rejects a non-integer', () => {
    expect(() =>
      tenantSettingsSchema.parse({ ...base, idempotencyKeyRetentionHours: 4.5 }),
    ).toThrow();
  });

  it('rejects a missing value', () => {
    expect(() => tenantSettingsSchema.parse(base)).toThrow();
  });
});

describe('clusterSettingsInputSchema', () => {
  it('accepts both null (will be deleted)', () => {
    expect(clusterSettingsInputSchema.parse({ warnThreshold: null, critThreshold: null })).toEqual({
      warnThreshold: null,
      critThreshold: null,
    });
  });

  it('accepts partial overrides (warn only)', () => {
    expect(clusterSettingsInputSchema.parse({ warnThreshold: 0.6, critThreshold: null })).toEqual({
      warnThreshold: 0.6,
      critThreshold: null,
    });
  });

  it('rejects warn >= crit when both are set', () => {
    expect(() =>
      clusterSettingsInputSchema.parse({ warnThreshold: 0.9, critThreshold: 0.7 }),
    ).toThrow();
  });

  it('does not enforce warn < crit when one is null', () => {
    expect(clusterSettingsInputSchema.parse({ warnThreshold: 0.95, critThreshold: null })).toEqual({
      warnThreshold: 0.95,
      critThreshold: null,
    });
  });
});

describe('effectiveThresholdsSchema', () => {
  it('accepts a resolved triple with source', () => {
    expect(effectiveThresholdsSchema.parse({ warn: 0.7, crit: 0.9, source: 'tenant' })).toEqual({
      warn: 0.7,
      crit: 0.9,
      source: 'tenant',
    });
  });

  it('rejects unknown source', () => {
    expect(() =>
      effectiveThresholdsSchema.parse({ warn: 0.7, crit: 0.9, source: 'galaxy' }),
    ).toThrow();
  });
});
