import { describe, expect, it } from 'vitest';

import { makeCluster, makeHost, makeSession, makeUser } from './factories.js';
import { prisma } from './setup.js';

describe('test factories', () => {
  it('makeHost honours the state option and defaults to in_service', async () => {
    const { id: clusterId } = await makeCluster(prisma);
    const { id: defaultId } = await makeHost(prisma, { clusterId });
    const { id: orderedId } = await makeHost(prisma, { clusterId, state: 'ordered' });

    const rows = await prisma.host.findMany({ where: { id: { in: [defaultId, orderedId] } } });
    const stateById = new Map(rows.map((h) => [h.id, h.state]));
    expect(stateById.get(defaultId)).toBe('in_service');
    expect(stateById.get(orderedId)).toBe('ordered');
  });

  it('makeUser defaults to ADMIN and makeSession creates a session bound to it', async () => {
    const admin = await makeUser(prisma);
    expect(admin.role).toBe('ADMIN');
    const viewer = await makeUser(prisma, { role: 'VIEWER', email: null });
    expect(viewer.role).toBe('VIEWER');
    expect(viewer.email).toBeNull();

    const { tokenHash } = await makeSession(prisma, { userId: admin.id });
    const session = await prisma.session.findUnique({ where: { tokenHash } });
    expect(session?.userId).toBe(admin.id);
    expect(session?.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });
});
