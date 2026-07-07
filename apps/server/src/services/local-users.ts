import type { Prisma, PrismaClient, User, UserRole } from '@prisma/client';

import type { LocalUserSummary, UpdateLocalUser } from '@lcm/shared';

import { hashPassword, verifyPassword } from '../crypto/password.js';

import { NotFoundError, UnprocessableError } from './errors.js';
import { translatePrismaError, type UniqueConstraintMapping } from './prisma-errors.js';

export const LOCAL_ISSUER = 'local';

/** Auth mode as tracked by `AuthConfigService` / `EffectiveAuthConfig`. */
export type AuthMode = 'disabled' | 'local' | 'oidc';

const USERNAME_TAKEN: UniqueConstraintMapping = {
  code: 'USERNAME_TAKEN',
  message: 'That username is already in use.',
};
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

  /**
   * The caller (route) is expected to do a friendly `findUnique` pre-check
   * first for the common case, but that check-then-create is a TOCTOU race
   * under concurrent requests — this `create()` is the authoritative guard:
   * a `@@unique([issuer, subject])` violation (P2002) is translated to the
   * same `USERNAME_TAKEN` error the pre-check throws.
   */
  async create(input: { username: string; password: string; role: UserRole }): Promise<User> {
    const passwordHash = await hashPassword(input.password);
    try {
      return await this.prisma.user.create({
        data: {
          issuer: LOCAL_ISSUER,
          subject: input.username,
          role: input.role,
          passwordHash,
          passwordUpdatedAt: new Date(),
        },
      });
    } catch (err) {
      translatePrismaError(err, { uniqueConstraint: USERNAME_TAKEN });
      throw err;
    }
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

  async update(userId: string, input: UpdateLocalUser): Promise<void> {
    // Built explicitly (rather than passing `input` straight through) because
    // `exactOptionalPropertyTypes` rejects Prisma's update-input type when an
    // optional zod key is present-but-`undefined`.
    const data: Prisma.UserUpdateInput = {};
    if (input.disabled !== undefined) data.disabled = input.disabled;
    if (input.role !== undefined) data.role = input.role;

    if (input.disabled === true) {
      await this.prisma.$transaction([
        this.prisma.user.update({ where: { id: userId }, data }),
        this.prisma.session.deleteMany({ where: { userId } }),
      ]);
      return;
    }
    await this.prisma.user.update({ where: { id: userId }, data });
  }

  async remove(userId: string): Promise<void> {
    await this.prisma.user.delete({ where: { id: userId } }); // sessions cascade
  }

  async enabledAdminCount(tx: Prisma.TransactionClient = this.prisma): Promise<number> {
    return tx.user.count({
      where: { issuer: LOCAL_ISSUER, role: 'ADMIN', disabled: false, passwordHash: { not: null } },
    });
  }

  /**
   * True when `target` is the last enabled local admin and `input`/`mode`
   * would take that away (disable it, demote it to VIEWER, or delete it).
   * Shared by `disableOrDemoteGuarded` and `removeGuarded` so the predicate
   * exists in exactly one place. Must run against the SAME `tx` the caller
   * is about to mutate on, under `Serializable` isolation, or the count and
   * the mutation could observe/act on different snapshots.
   */
  private async isLastEnabledLocalAdmin(
    target: User,
    wouldRemoveAdminAccess: boolean,
    mode: AuthMode,
    tx: Prisma.TransactionClient,
  ): Promise<boolean> {
    return (
      wouldRemoveAdminAccess &&
      mode === 'local' &&
      target.role === 'ADMIN' &&
      !target.disabled &&
      (await this.enabledAdminCount(tx)) <= 1
    );
  }

  /**
   * Fetches a `local`-issued user by id inside `tx`, or throws
   * `NotFoundError` — same scoping as the route's `findLocalUserOrNotFound`,
   * duplicated here (rather than shared) because it must run on the
   * transaction's own client to see a consistent snapshot.
   */
  private async findLocalUserOrNotFound(tx: Prisma.TransactionClient, id: string): Promise<User> {
    const target = await tx.user.findUnique({ where: { id } });
    if (!target || target.issuer !== LOCAL_ISSUER) {
      throw new NotFoundError('LocalUser', id);
    }
    return target;
  }

  /**
   * Atomically guards + applies a PATCH (disable/enable, role change) on a
   * local user: the last-enabled-admin count check and the mutation (plus
   * the session cleanup a disable triggers) all run on the same
   * `Serializable` transaction, so two concurrent requests can no longer
   * both observe "2 enabled admins" and both proceed (P2034 write conflicts
   * are translated to `WRITE_CONFLICT` so the client can retry).
   */
  async disableOrDemoteGuarded(
    userId: string,
    input: UpdateLocalUser,
    mode: AuthMode,
  ): Promise<void> {
    const data: Prisma.UserUpdateInput = {};
    if (input.disabled !== undefined) data.disabled = input.disabled;
    if (input.role !== undefined) data.role = input.role;
    const wouldRemoveAdminAccess = input.disabled === true || input.role === 'VIEWER';

    try {
      await this.prisma.$transaction(
        async (tx) => {
          const target = await this.findLocalUserOrNotFound(tx, userId);

          if (await this.isLastEnabledLocalAdmin(target, wouldRemoveAdminAccess, mode, tx)) {
            throw new UnprocessableError(
              'LAST_LOCAL_ADMIN',
              'Cannot disable or demote the last enabled local admin while local authentication is active.',
            );
          }

          await tx.user.update({ where: { id: userId }, data });
          if (input.disabled === true) {
            await tx.session.deleteMany({ where: { userId } });
          }
        },
        { isolationLevel: 'Serializable' },
      );
    } catch (err) {
      translatePrismaError(err);
      throw err;
    }
  }

  /**
   * Atomically guards + applies a DELETE on a local user — same rationale as
   * `disableOrDemoteGuarded`: the count check and the delete (sessions
   * cascade) run on one `Serializable` transaction.
   */
  async removeGuarded(userId: string, mode: AuthMode): Promise<void> {
    try {
      await this.prisma.$transaction(
        async (tx) => {
          const target = await this.findLocalUserOrNotFound(tx, userId);

          if (await this.isLastEnabledLocalAdmin(target, true, mode, tx)) {
            throw new UnprocessableError(
              'LAST_LOCAL_ADMIN',
              'Cannot delete the last enabled local admin while local authentication is active.',
            );
          }

          await tx.user.delete({ where: { id: userId } }); // sessions cascade
        },
        { isolationLevel: 'Serializable' },
      );
    } catch (err) {
      translatePrismaError(err);
      throw err;
    }
  }

  async enabledCount(): Promise<number> {
    return this.prisma.user.count({
      where: { issuer: LOCAL_ISSUER, disabled: false, passwordHash: { not: null } },
    });
  }
}
