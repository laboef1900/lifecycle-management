import { describe, expect, it } from 'vitest';

import { makeCluster } from './factories.js';
import { prisma } from './setup.js';

const COMMISSIONED = new Date('2026-05-01');

async function createHost(clusterId: string, serialNumber: string | null, name: string) {
  return prisma.host.create({
    data: { tenantId: 'default', clusterId, name, commissionedAt: COMMISSIONED, serialNumber },
  });
}

describe('hosts serial-number uniqueness', () => {
  it('index is a full unique index with no partial predicate (schema/DB agree, #123)', async () => {
    const rows = await prisma.$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'hosts' AND indexname = 'hosts_tenant_serial_unique'
    `;
    expect(rows).toHaveLength(1);
    const def = rows[0]?.indexdef ?? '';
    expect(def).toContain('UNIQUE INDEX');
    // The partial predicate is gone — that mismatch was the source of the drift.
    expect(def).not.toMatch(/WHERE/i);
  });

  it('rejects a duplicate non-null serial within the same tenant', async () => {
    const { id: clusterId } = await makeCluster(prisma);
    await createHost(clusterId, 'SN-DUP-001', 'host-a');
    await expect(createHost(clusterId, 'SN-DUP-001', 'host-b')).rejects.toMatchObject({
      code: 'P2002',
    });
  });

  it('still allows multiple NULL serials within the same tenant', async () => {
    const { id: clusterId } = await makeCluster(prisma);
    await expect(createHost(clusterId, null, 'host-null-1')).resolves.toBeDefined();
    await expect(createHost(clusterId, null, 'host-null-2')).resolves.toBeDefined();
  });
});
