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
    expect(tenantSettingsSchema.parse({ warnThreshold: 0.7, critThreshold: 0.9 })).toEqual({
      warnThreshold: 0.7,
      critThreshold: 0.9,
    });
  });

  it('rejects warn === crit', () => {
    expect(() => tenantSettingsSchema.parse({ warnThreshold: 0.8, critThreshold: 0.8 })).toThrow();
  });

  it('rejects warn > crit', () => {
    expect(() => tenantSettingsSchema.parse({ warnThreshold: 0.9, critThreshold: 0.7 })).toThrow();
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
