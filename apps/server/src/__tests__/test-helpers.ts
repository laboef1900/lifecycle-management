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

export function makeFakePrisma(options: FakePrismaOptions = {}): PrismaClient {
  const fake = {
    $connect: vi.fn().mockResolvedValue(undefined),
    $disconnect: vi.fn().mockResolvedValue(undefined),
    $queryRaw: options.queryRaw ?? vi.fn().mockResolvedValue([{ ok: 1 }]),
    $transaction: options.transaction ?? vi.fn().mockResolvedValue(undefined),
  };
  return fake as unknown as PrismaClient;
}
