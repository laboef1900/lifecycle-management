import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { inferCategory, parseCapacityXlsx } from './parse-capacity-xlsx.js';

const REAL_XLSX = resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  'docs',
  'Capacity_Forecast_vSphere.xlsx',
);

describe('inferCategory', () => {
  it('maps Wachstum* to growth', () => {
    expect(inferCategory('Wachstum Q4')).toBe('growth');
    expect(inferCategory('wachstum 2027')).toBe('growth');
  });

  it('maps Ausbau* and Umbau* to hardware_change', () => {
    expect(inferCategory('Ausbau Memory HPE-Server')).toBe('hardware_change');
    expect(inferCategory('Ausbau 2x HPE Server')).toBe('hardware_change');
    expect(inferCategory('Umbau - ClientLab Hardware nach Prod-P2')).toBe('hardware_change');
  });

  it('maps any title containing OpenShift to openshift (case-insensitive)', () => {
    expect(inferCategory('OpenShift - Aufbau Labor Umgebung (DMZ)')).toBe('openshift');
    expect(inferCategory('START OpenShift')).toBe('openshift');
    expect(inferCategory('Ausbau - OpenShift Cluster Expansion')).toBe('hardware_change'); // Ausbau wins (earlier rule)
  });

  it('throws on an unmapped prefix, naming the offending title', () => {
    expect(() => inferCategory('Foobar Q1')).toThrow(/Foobar Q1/);
  });
});

describe('parseCapacityXlsx (real spreadsheet)', () => {
  it('returns the four reference clusters in spreadsheet order with seed-matching baselines', () => {
    const clusters = parseCapacityXlsx(REAL_XLSX);

    expect(clusters).toHaveLength(4);
    expect(clusters.map((c) => c.name)).toEqual([
      'CL-DMZ-P1',
      'CL-Prod-P2',
      'CL-Test-P2',
      'CL-Prod-P2-Oracle',
    ]);

    const byName = Object.fromEntries(clusters.map((c) => [c.name, c]));
    expect(byName['CL-DMZ-P1']).toMatchObject({
      baselineConsumption: 3378,
      baselineCapacity: 7680,
    });
    expect(byName['CL-Prod-P2']).toMatchObject({
      baselineConsumption: 19188,
      baselineCapacity: 40960,
    });
    expect(byName['CL-Test-P2']).toMatchObject({
      baselineConsumption: 3345,
      baselineCapacity: 8192,
    });
    expect(byName['CL-Prod-P2-Oracle']).toMatchObject({
      baselineConsumption: 1564,
      baselineCapacity: 4096,
    });
  });

  it('filters zero-delta events: CL-Prod-P2-Oracle has none, totals are 12/9/11/0', () => {
    const clusters = parseCapacityXlsx(REAL_XLSX);
    const counts = Object.fromEntries(clusters.map((c) => [c.name, c.events.length]));
    expect(counts).toEqual({
      'CL-DMZ-P1': 12,
      'CL-Prod-P2': 9,
      'CL-Test-P2': 11,
      'CL-Prod-P2-Oracle': 0,
    });
  });

  it('maps column L to October 2026 (L→K rule): "Ausbau Memory HPE-Server" lands on 2026-10-01', () => {
    const clusters = parseCapacityXlsx(REAL_XLSX);
    const dmz = clusters.find((c) => c.name === 'CL-DMZ-P1');
    const ev = dmz?.events.find((e) => e.title === 'Ausbau Memory HPE-Server');
    expect(ev).toEqual({
      effectiveDate: '2026-10-01',
      title: 'Ausbau Memory HPE-Server',
      category: 'hardware_change',
      capacityDelta: 2560,
      consumptionDelta: null,
    });
  });

  it('maps column P to January 2027 (P→O rule): the CL-DMZ-P1 "OpenShift - Aufbau Prod" event lands on 2027-01-01 with consumption 880', () => {
    const clusters = parseCapacityXlsx(REAL_XLSX);
    const dmz = clusters.find((c) => c.name === 'CL-DMZ-P1');
    const ev = dmz?.events.find((e) => e.title === 'OpenShift - Aufbau Prod Umgebung (DMZ)');
    expect(ev).toEqual({
      effectiveDate: '2027-01-01',
      title: 'OpenShift - Aufbau Prod Umgebung (DMZ)',
      category: 'openshift',
      capacityDelta: null,
      consumptionDelta: 880,
    });
  });

  it('preserves event order within a cluster (ascending by effectiveDate)', () => {
    const clusters = parseCapacityXlsx(REAL_XLSX);
    const dmz = clusters.find((c) => c.name === 'CL-DMZ-P1');
    const dates = dmz?.events.map((e) => e.effectiveDate) ?? [];
    const sorted = [...dates].sort();
    expect(dates).toEqual(sorted);
  });
});
