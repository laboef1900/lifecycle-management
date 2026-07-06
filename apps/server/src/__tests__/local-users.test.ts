import { describe, expect, it } from 'vitest';

import { LocalUserService, MAX_FAILED_ATTEMPTS } from '../services/local-users.js';
import { prisma } from './setup.js';

const svc = new LocalUserService(prisma);

describe('LocalUserService', () => {
  it('creates a local admin that can log in', async () => {
    await svc.create({ username: 'root', password: 'twelvecharsok!', role: 'ADMIN' });
    const result = await svc.verifyLogin('root', 'twelvecharsok!');
    expect(result.ok).toBe(true);
  });

  it('rejects a wrong password and, after the threshold, locks the account', async () => {
    await svc.create({ username: 'lockme', password: 'twelvecharsok!', role: 'ADMIN' });
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i += 1) {
      expect((await svc.verifyLogin('lockme', 'wrong-password')).ok).toBe(false);
    }
    // Correct password now also fails: the account is locked.
    expect((await svc.verifyLogin('lockme', 'twelvecharsok!')).ok).toBe(false);
    const row = await prisma.user.findUniqueOrThrow({
      where: { issuer_subject: { issuer: 'local', subject: 'lockme' } },
    });
    expect(row.lockedUntil).not.toBeNull();
  });

  it('returns ok:false for an unknown user (no enumeration)', async () => {
    expect((await svc.verifyLogin('ghost', 'whatever-pass')).ok).toBe(false);
  });

  it('counts only enabled local admins', async () => {
    const before = await svc.enabledAdminCount();
    const u = await svc.create({ username: 'counted', password: 'twelvecharsok!', role: 'ADMIN' });
    expect(await svc.enabledAdminCount()).toBe(before + 1);
    await svc.update(u.id, { disabled: true });
    expect(await svc.enabledAdminCount()).toBe(before);
  });

  it('changes own password only with the correct current password', async () => {
    const u = await svc.create({ username: 'changer', password: 'twelvecharsok!', role: 'ADMIN' });
    expect(await svc.changeOwnPassword(u.id, 'nope-nope-nope', 'newtwelvechars!')).toBe(false);
    expect(await svc.changeOwnPassword(u.id, 'twelvecharsok!', 'newtwelvechars!')).toBe(true);
    expect((await svc.verifyLogin('changer', 'newtwelvechars!')).ok).toBe(true);
  });
});
