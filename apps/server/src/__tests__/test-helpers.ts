import type { PrismaClient } from '@prisma/client';
import { vi } from 'vitest';

import type { Env } from '../env.js';

export function makeTestEnv(overrides: Partial<Env> = {}): Env {
  return {
    DATABASE_URL: 'postgresql://lcm:lcm@localhost:5432/lcm_test',
    PORT: 0,
    HOST: '127.0.0.1',
    LOG_LEVEL: 'silent',
    NODE_ENV: 'test',
    TRUST_PROXY: 'loopback,uniquelocal',
    RATE_LIMIT_MAX: 300,
    AUTH_MODE: 'disabled',
    SESSION_TTL_HOURS: 12,
    OIDC_SCOPES: 'openid profile email',
    OIDC_DEFAULT_ROLE: 'admin',
    OIDC_ALLOW_INSECURE: false,
    ...overrides,
  } as Env;
}

/** Env for auth tests: AUTH_MODE=oidc with a complete (mock-friendly) OIDC config. */
export function makeOidcTestEnv(overrides: Partial<Env> = {}): Env {
  return makeTestEnv({
    AUTH_MODE: 'oidc',
    OIDC_ISSUER_URL: 'http://127.0.0.1:1/oidc',
    OIDC_CLIENT_ID: 'lcm-test',
    OIDC_CLIENT_SECRET: 'lcm-test-secret',
    APP_BASE_URL: 'http://127.0.0.1:8080',
    LOGIN_STATE_SECRET: 'test-login-state-secret-0123456789abcdef',
    OIDC_ALLOW_INSECURE: true,
    ...overrides,
  });
}

export interface FakePrismaOptions {
  queryRaw?: ReturnType<typeof vi.fn>;
  transaction?: ReturnType<typeof vi.fn>;
}

/**
 * Default singleton row returned by the fake `authConfig` model — a
 * disabled config with no secrets, matching what `AuthConfigService.load()`
 * expects to find so it treats the row as already-seeded and never attempts
 * to create/update anything on boot.
 */
const defaultAuthConfigRow = {
  id: 'singleton',
  mode: 'disabled',
  issuerUrl: null,
  clientId: null,
  clientSecretEnc: null,
  signingSecretEnc: null,
  appBaseUrl: null,
  scopes: 'openid profile email',
  roleClaim: null,
  adminValues: null,
  defaultRole: 'admin',
  allowedEmailDomains: null,
  allowedEmails: null,
  sessionTtlHours: 12,
  allowInsecure: false,
  updatedAt: new Date(),
  updatedByUserId: null,
};

export function makeFakePrisma(options: FakePrismaOptions = {}): PrismaClient {
  const fake = {
    $connect: vi.fn().mockResolvedValue(undefined),
    $disconnect: vi.fn().mockResolvedValue(undefined),
    $queryRaw: options.queryRaw ?? vi.fn().mockResolvedValue([{ ok: 1 }]),
    $transaction: options.transaction ?? vi.fn().mockResolvedValue(undefined),
    // Minimal stub so plugins that touch `prisma.authConfig` on boot (the
    // auth-config plugin, unconditionally) don't crash when a test builds
    // the server with a fake Prisma client instead of a real database.
    authConfig: {
      findUnique: vi.fn().mockResolvedValue(defaultAuthConfigRow),
      create: vi.fn().mockResolvedValue(defaultAuthConfigRow),
      update: vi.fn().mockResolvedValue(defaultAuthConfigRow),
      upsert: vi.fn().mockResolvedValue(defaultAuthConfigRow),
    },
  };
  return fake as unknown as PrismaClient;
}
