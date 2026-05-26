import type { PrismaClient } from '@prisma/client';

import {
  resolveThresholds,
  SYSTEM_DEFAULTS,
  type ClusterSettingsInput,
  type ClusterSettingsResponse,
  type EffectiveThresholds,
  type TenantSettings,
} from '@lcm/shared';

import { NotFoundError, UnprocessableError } from './errors.js';

function decimalToNumber(value: unknown): number {
  if (value === null || value === undefined) {
    throw new Error('Cannot convert null/undefined to number');
  }
  if (typeof value === 'object' && value !== null && 'toNumber' in value) {
    return (value as { toNumber: () => number }).toNumber();
  }
  return Number(value);
}

function decimalToNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return decimalToNumber(value);
}

export class SettingsService {
  constructor(private readonly prisma: PrismaClient) {}

  async getTenant(tenantId: string): Promise<TenantSettings> {
    const row = await this.prisma.tenantSettings.upsert({
      where: { tenantId },
      create: { tenantId },
      update: {},
    });
    return {
      warnThreshold: decimalToNumber(row.warnThreshold),
      critThreshold: decimalToNumber(row.critThreshold),
      procurementLeadTimeWeeks: row.procurementLeadTimeWeeks,
    };
  }

  async updateTenant(tenantId: string, input: TenantSettings): Promise<TenantSettings> {
    const row = await this.prisma.tenantSettings.upsert({
      where: { tenantId },
      create: {
        tenantId,
        warnThreshold: input.warnThreshold,
        critThreshold: input.critThreshold,
        procurementLeadTimeWeeks: input.procurementLeadTimeWeeks,
      },
      update: {
        warnThreshold: input.warnThreshold,
        critThreshold: input.critThreshold,
        procurementLeadTimeWeeks: input.procurementLeadTimeWeeks,
      },
    });
    return {
      warnThreshold: decimalToNumber(row.warnThreshold),
      critThreshold: decimalToNumber(row.critThreshold),
      procurementLeadTimeWeeks: row.procurementLeadTimeWeeks,
    };
  }

  async getCluster(tenantId: string, clusterId: string): Promise<ClusterSettingsResponse> {
    await this.assertClusterExists(tenantId, clusterId);
    const row = await this.prisma.clusterSettings.findUnique({
      where: { clusterId },
    });
    const cluster = row
      ? {
          warnThreshold: decimalToNullableNumber(row.warnThreshold),
          critThreshold: decimalToNullableNumber(row.critThreshold),
        }
      : null;
    const tenant = await this.getTenant(tenantId);
    const effective = this.computeEffective(cluster, tenant);
    return {
      warnThreshold: cluster?.warnThreshold ?? null,
      critThreshold: cluster?.critThreshold ?? null,
      effective,
    };
  }

  async updateCluster(
    tenantId: string,
    clusterId: string,
    input: ClusterSettingsInput,
  ): Promise<ClusterSettingsResponse> {
    await this.assertClusterExists(tenantId, clusterId);
    const tenant = await this.getTenant(tenantId);
    const candidate = this.computeEffective(input, tenant);
    if (candidate.warn >= candidate.crit) {
      throw new UnprocessableError(
        'EFFECTIVE_THRESHOLDS_INVALID',
        `Effective warn (${candidate.warn}) must be less than effective crit (${candidate.crit}).`,
      );
    }
    const row = await this.prisma.clusterSettings.upsert({
      where: { clusterId },
      create: {
        clusterId,
        warnThreshold: input.warnThreshold,
        critThreshold: input.critThreshold,
      },
      update: {
        warnThreshold: input.warnThreshold,
        critThreshold: input.critThreshold,
      },
    });
    const cluster = {
      warnThreshold: decimalToNullableNumber(row.warnThreshold),
      critThreshold: decimalToNullableNumber(row.critThreshold),
    };
    return {
      warnThreshold: cluster.warnThreshold,
      critThreshold: cluster.critThreshold,
      effective: this.computeEffective(cluster, tenant),
    };
  }

  async resetCluster(tenantId: string, clusterId: string): Promise<ClusterSettingsResponse> {
    await this.assertClusterExists(tenantId, clusterId);
    await this.prisma.clusterSettings.delete({ where: { clusterId } }).catch((err: unknown) => {
      if (
        err &&
        typeof err === 'object' &&
        'code' in err &&
        (err as { code?: string }).code === 'P2025'
      ) {
        return;
      }
      throw err;
    });
    const tenant = await this.getTenant(tenantId);
    return {
      warnThreshold: null,
      critThreshold: null,
      effective: this.computeEffective(null, tenant),
    };
  }

  async effectiveFor(tenantId: string, clusterId: string): Promise<EffectiveThresholds> {
    const result = await this.getCluster(tenantId, clusterId);
    return result.effective;
  }

  private async assertClusterExists(tenantId: string, clusterId: string): Promise<void> {
    const cluster = await this.prisma.cluster.findFirst({
      where: { id: clusterId, tenantId },
      select: { id: true },
    });
    if (!cluster) {
      throw new NotFoundError('Cluster', clusterId);
    }
  }

  private computeEffective(
    cluster: ClusterSettingsInput | null,
    tenant: TenantSettings | null,
  ): EffectiveThresholds {
    const resolved = resolveThresholds(cluster, tenant, SYSTEM_DEFAULTS);
    let source: EffectiveThresholds['source'] = 'system';
    if (tenant) source = 'tenant';
    if (cluster && (cluster.warnThreshold !== null || cluster.critThreshold !== null)) {
      source = 'cluster';
    }
    return { warn: resolved.warn, crit: resolved.crit, source };
  }
}
