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
    ...overrides,
  };
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
