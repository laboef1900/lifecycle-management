import { describe, expect, it } from 'vitest';

import { SessionService, hashSessionToken } from '../services/sessions.js';
import { prisma } from './setup.js';

async function createUser(): Promise<string> {
  const user = await prisma.user.create({
    data: { issuer: 'https://idp.test', subject: 'sub-1', email: 'a@example.com', role: 'ADMIN' },
  });
  return user.id;
}

describe('SessionService', () => {
  const service = new SessionService(prisma);

  it('creates a session and finds the user by raw token', async () => {
    const userId = await createUser();
    const { token, expiresAt } = await service.create(userId, 12);

    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
    // Only the hash is stored.
    const row = await prisma.session.findUnique({ where: { tokenHash: hashSessionToken(token) } });
    expect(row).not.toBeNull();
    expect(row?.tokenHash).not.toBe(token);

    const user = await service.findUserByToken(token);
    expect(user).toMatchObject({ id: userId, tenantId: 'default', role: 'ADMIN' });
  });

  it('returns null for unknown or expired tokens', async () => {
    expect(await service.findUserByToken('nope')).toBeNull();

    const userId = await createUser();
    const { token } = await service.create(userId, 12);
    await prisma.session.updateMany({
      where: { userId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(await service.findUserByToken(token)).toBeNull();
  });

  it('destroy removes the session; expired sessions are cleaned at next login', async () => {
    const userId = await createUser();
    const { token } = await service.create(userId, 12);
    await service.destroy(token);
    expect(await service.findUserByToken(token)).toBeNull();

    await prisma.session.create({
      data: { tokenHash: 'stale', userId, expiresAt: new Date(Date.now() - 1000) },
    });
    await service.create(userId, 12);
    expect(await prisma.session.findUnique({ where: { tokenHash: 'stale' } })).toBeNull();
  });
});
