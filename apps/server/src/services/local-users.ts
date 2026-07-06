import type { PrismaClient, User, UserRole } from '@prisma/client';

import type { LocalUserSummary } from '@lcm/shared';

import { hashPassword, verifyPassword } from '../crypto/password.js';

export const LOCAL_ISSUER = 'local';
export const MAX_FAILED_ATTEMPTS = 5;
const MAX_LOCK_MINUTES = 15;

export type VerifyLoginResult = { ok: true; user: User } | { ok: false };

/** Minutes to lock after N total consecutive failures (exponential, capped). */
function lockMinutes(attempts: number): number {
  const over = attempts - MAX_FAILED_ATTEMPTS;
  if (over < 0) return 0;
  return Math.min(MAX_LOCK_MINUTES, 2 ** over);
}

export class LocalUserService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * A cached argon2id hash used to spend verify-time on unknown usernames so a
   * missing account is timing-indistinguishable from a wrong password. Lazily
   * computed once per process.
   */
  private dummyHash: Promise<string> | null = null;
  private getDummyHash(): Promise<string> {
    this.dummyHash ??= hashPassword('unused-timing-equalizer');
    return this.dummyHash;
  }

  async create(input: { username: string; password: string; role: UserRole }): Promise<User> {
    const passwordHash = await hashPassword(input.password);
    return this.prisma.user.create({
      data: {
        issuer: LOCAL_ISSUER,
        subject: input.username,
        role: input.role,
        passwordHash,
        passwordUpdatedAt: new Date(),
      },
    });
  }

  async verifyLogin(username: string, password: string): Promise<VerifyLoginResult> {
    const user = await this.prisma.user.findUnique({
      where: { issuer_subject: { issuer: LOCAL_ISSUER, subject: username } },
    });

    if (!user || user.passwordHash === null || user.disabled) {
      await verifyPassword(await this.getDummyHash(), password); // equalize timing
      return { ok: false };
    }
    if (user.lockedUntil !== null && user.lockedUntil.getTime() > Date.now()) {
      await verifyPassword(await this.getDummyHash(), password);
      return { ok: false };
    }

    const ok = await verifyPassword(user.passwordHash, password);
    if (!ok) {
      const updated = await this.prisma.user.update({
        where: { id: user.id },
        data: { failedLoginAttempts: { increment: 1 } },
      });
      const minutes = lockMinutes(updated.failedLoginAttempts);
      if (minutes > 0) {
        await this.prisma.user.update({
          where: { id: user.id },
          data: { lockedUntil: new Date(Date.now() + minutes * 60_000) },
        });
      }
      return { ok: false };
    }

    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: { failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: new Date() },
    });
    return { ok: true, user: updated };
  }

  async changeOwnPassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<boolean> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.passwordHash === null) return false;
    if (!(await verifyPassword(user.passwordHash, currentPassword))) return false;
    await this.setPassword(userId, newPassword);
    return true;
  }

  async resetPassword(userId: string, newPassword: string): Promise<void> {
    await this.setPassword(userId, newPassword);
  }

  private async setPassword(userId: string, newPassword: string): Promise<void> {
    const passwordHash = await hashPassword(newPassword);
    // Revoke all existing sessions on a password change/reset.
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: {
          passwordHash,
          passwordUpdatedAt: new Date(),
          failedLoginAttempts: 0,
          lockedUntil: null,
        },
      }),
      this.prisma.session.deleteMany({ where: { userId } }),
    ]);
  }

  async list(): Promise<LocalUserSummary[]> {
    const rows = await this.prisma.user.findMany({
      where: { issuer: LOCAL_ISSUER },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((u) => ({
      id: u.id,
      username: u.subject,
      role: u.role,
      disabled: u.disabled,
      lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
      createdAt: u.createdAt.toISOString(),
    }));
  }

  async update(userId: string, input: { disabled?: boolean; role?: UserRole }): Promise<void> {
    if (input.disabled === true) {
      await this.prisma.$transaction([
        this.prisma.user.update({ where: { id: userId }, data: input }),
        this.prisma.session.deleteMany({ where: { userId } }),
      ]);
      return;
    }
    await this.prisma.user.update({ where: { id: userId }, data: input });
  }

  async remove(userId: string): Promise<void> {
    await this.prisma.user.delete({ where: { id: userId } }); // sessions cascade
  }

  async enabledAdminCount(): Promise<number> {
    return this.prisma.user.count({
      where: { issuer: LOCAL_ISSUER, role: 'ADMIN', disabled: false, passwordHash: { not: null } },
    });
  }

  async enabledCount(): Promise<number> {
    return this.prisma.user.count({
      where: { issuer: LOCAL_ISSUER, disabled: false, passwordHash: { not: null } },
    });
  }
}
