import type { PrismaClient, User, UserRole } from '@prisma/client';

import type { EffectiveAuthConfig } from './auth-config.js';

/** Identity extracted from a validated OIDC ID token. */
export interface OidcIdentity {
  issuer: string;
  subject: string;
  email?: string;
  name?: string;
  claims: Record<string, unknown>;
}

function csv(value: string | null | undefined): string[] {
  return (
    value
      ?.split(',')
      .map((entry) => entry.trim())
      .filter(Boolean) ?? []
  );
}

/**
 * Role is re-computed from claims at every login — the IdP is the source of
 * truth; the stored role is a cache for mid-session reads and future audit.
 */
export function computeRole(claims: Record<string, unknown>, cfg: EffectiveAuthConfig): UserRole {
  const fallback: UserRole = cfg.defaultRole === 'admin' ? 'ADMIN' : 'VIEWER';
  if (!cfg.roleClaim || !cfg.adminValues) return fallback;
  const adminValues = csv(cfg.adminValues);
  const raw = claims[cfg.roleClaim];
  const values = Array.isArray(raw)
    ? raw.filter((entry): entry is string => typeof entry === 'string')
    : typeof raw === 'string'
      ? [raw]
      : [];
  return values.some((value) => adminValues.includes(value)) ? 'ADMIN' : 'VIEWER';
}

/** With an allowlist configured, a login without a matching email is rejected. */
export function isEmailAllowed(email: string | undefined, cfg: EffectiveAuthConfig): boolean {
  const allowedEmails = csv(cfg.allowedEmails).map((entry) => entry.toLowerCase());
  const allowedDomains = csv(cfg.allowedEmailDomains).map((entry) => entry.toLowerCase());
  if (allowedEmails.length === 0 && allowedDomains.length === 0) return true;
  if (!email) return false;
  const normalized = email.toLowerCase();
  if (allowedEmails.includes(normalized)) return true;
  const domain = normalized.split('@')[1];
  return domain !== undefined && allowedDomains.includes(domain);
}

export class UserService {
  constructor(private readonly prisma: PrismaClient) {}

  async upsertFromIdentity(identity: OidcIdentity, cfg: EffectiveAuthConfig): Promise<User> {
    const role = computeRole(identity.claims, cfg);
    const profile = {
      email: identity.email ?? null,
      displayName: identity.name ?? null,
      role,
      lastLoginAt: new Date(),
    };
    return this.prisma.user.upsert({
      where: { issuer_subject: { issuer: identity.issuer, subject: identity.subject } },
      update: profile,
      create: { issuer: identity.issuer, subject: identity.subject, ...profile },
    });
  }
}
