import type { PrismaClient, User, UserRole } from '@prisma/client';

import type { Env } from '../env.js';

/** Identity extracted from a validated OIDC ID token. */
export interface OidcIdentity {
  issuer: string;
  subject: string;
  email?: string;
  name?: string;
  claims: Record<string, unknown>;
}

function csv(value: string | undefined): string[] {
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
export function computeRole(claims: Record<string, unknown>, env: Env): UserRole {
  const fallback: UserRole = env.OIDC_DEFAULT_ROLE === 'admin' ? 'ADMIN' : 'VIEWER';
  if (!env.OIDC_ROLE_CLAIM || !env.OIDC_ADMIN_VALUES) return fallback;
  const adminValues = csv(env.OIDC_ADMIN_VALUES);
  const raw = claims[env.OIDC_ROLE_CLAIM];
  const values = Array.isArray(raw)
    ? raw.filter((entry): entry is string => typeof entry === 'string')
    : typeof raw === 'string'
      ? [raw]
      : [];
  return values.some((value) => adminValues.includes(value)) ? 'ADMIN' : 'VIEWER';
}

/** With an allowlist configured, a login without a matching email is rejected. */
export function isEmailAllowed(email: string | undefined, env: Env): boolean {
  const allowedEmails = csv(env.OIDC_ALLOWED_EMAILS).map((entry) => entry.toLowerCase());
  const allowedDomains = csv(env.OIDC_ALLOWED_EMAIL_DOMAINS).map((entry) => entry.toLowerCase());
  if (allowedEmails.length === 0 && allowedDomains.length === 0) return true;
  if (!email) return false;
  const normalized = email.toLowerCase();
  if (allowedEmails.includes(normalized)) return true;
  const domain = normalized.split('@')[1];
  return domain !== undefined && allowedDomains.includes(domain);
}

export class UserService {
  constructor(private readonly prisma: PrismaClient) {}

  async upsertFromIdentity(identity: OidcIdentity, env: Env): Promise<User> {
    const role = computeRole(identity.claims, env);
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
