import { createHash, randomBytes } from 'node:crypto';

import type { PrismaClient, UserRole } from '@prisma/client';

/** Authenticated principal attached to each request. */
export interface SessionUser {
  id: string;
  tenantId: string;
  email: string | null;
  displayName: string | null;
  role: UserRole;
}

/** Sessions are self-authenticating opaque tokens; only the SHA-256 is at rest. */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export class SessionService {
  constructor(private readonly prisma: PrismaClient) {}

  async create(userId: string, ttlHours: number): Promise<{ token: string; expiresAt: Date }> {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + ttlHours * 3_600_000);
    // Opportunistic cleanup: a login is the natural moment to drop this
    // user's expired sessions (no background sweeper needed at this scale).
    await this.prisma.session.deleteMany({ where: { userId, expiresAt: { lt: new Date() } } });
    await this.prisma.session.create({
      data: { tokenHash: hashSessionToken(token), userId, expiresAt },
    });
    return { token, expiresAt };
  }

  async findUserByToken(token: string): Promise<SessionUser | null> {
    const session = await this.prisma.session.findUnique({
      where: { tokenHash: hashSessionToken(token) },
      include: { user: true },
    });
    if (!session || session.expiresAt.getTime() <= Date.now()) return null;
    const { user } = session;
    return {
      id: user.id,
      tenantId: user.tenantId,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
    };
  }

  async destroy(token: string): Promise<void> {
    await this.prisma.session.deleteMany({ where: { tokenHash: hashSessionToken(token) } });
  }
}
