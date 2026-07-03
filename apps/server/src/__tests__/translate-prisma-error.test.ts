import { Prisma } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConflictError } from '../services/errors.js';
import { translatePrismaError } from '../services/prisma-errors.js';
import { buildServer } from '../server.js';

import { makeFakePrisma, makeTestEnv } from './test-helpers.js';

/**
 * Focused unit coverage for the shared Prisma error translator plus one
 * wire-level test proving that a transaction-thrown P2034 actually surfaces
 * as HTTP 409 WRITE_CONFLICT through the fastify error handler (the unit
 * tests exercise the translator, not the wiring).
 */
function makeKnownRequestError(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('synthetic prisma error', {
    code,
    clientVersion: Prisma.prismaVersion.client,
  });
}

function capture(fn: () => void): unknown {
  let thrown: unknown;
  try {
    fn();
  } catch (caught) {
    thrown = caught;
  }
  return thrown;
}

describe('translatePrismaError', () => {
  it('maps P2034 to a 409 WRITE_CONFLICT ConflictError', () => {
    const thrown = capture(() => translatePrismaError(makeKnownRequestError('P2034')));

    expect(thrown).toBeInstanceOf(ConflictError);
    expect((thrown as ConflictError).statusCode).toBe(409);
    expect((thrown as ConflictError).code).toBe('WRITE_CONFLICT');
  });

  it('maps P2034 to WRITE_CONFLICT even when a uniqueConstraint mapping is provided', () => {
    const thrown = capture(() =>
      translatePrismaError(makeKnownRequestError('P2034'), {
        uniqueConstraint: { code: 'CAPACITY_DUPLICATE_DATE', message: 'duplicate' },
      }),
    );

    expect(thrown).toBeInstanceOf(ConflictError);
    expect((thrown as ConflictError).code).toBe('WRITE_CONFLICT');
  });

  it('maps P2002 to the caller-supplied unique-constraint ConflictError', () => {
    const thrown = capture(() =>
      translatePrismaError(makeKnownRequestError('P2002'), {
        uniqueConstraint: {
          code: 'CLUSTER_NAME_TAKEN',
          message: 'A cluster named "prod" already exists in this tenant',
        },
      }),
    );

    expect(thrown).toBeInstanceOf(ConflictError);
    expect((thrown as ConflictError).statusCode).toBe(409);
    expect((thrown as ConflictError).code).toBe('CLUSTER_NAME_TAKEN');
    expect((thrown as ConflictError).message).toBe(
      'A cluster named "prod" already exists in this tenant',
    );
  });

  it('leaves P2002 untranslated when no uniqueConstraint mapping is provided', () => {
    expect(() => translatePrismaError(makeKnownRequestError('P2002'))).not.toThrow();
  });

  it('leaves other known Prisma errors untranslated (no throw)', () => {
    expect(() => translatePrismaError(makeKnownRequestError('P2025'))).not.toThrow();
  });

  it('leaves unrelated errors untranslated (no throw)', () => {
    expect(() => translatePrismaError(new Error('boom'))).not.toThrow();
    expect(() => translatePrismaError(undefined)).not.toThrow();
  });
});

describe('P2034 wire-level mapping', () => {
  const created: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    while (created.length) {
      const server = created.pop();
      await server?.close();
    }
  });

  it('POST /api/hosts/:id/capacity returns 409 WRITE_CONFLICT when the transaction throws P2034', async () => {
    const prisma = makeFakePrisma({
      transaction: vi.fn().mockRejectedValue(makeKnownRequestError('P2034')),
    });
    const server = await buildServer({ env: makeTestEnv(), prisma });
    created.push(server);

    const response = await server.inject({
      method: 'POST',
      url: '/api/hosts/ckhost00000000000000000001/capacity',
      payload: { metricTypeKey: 'vcpu', effectiveFrom: '2026-01-01', amount: 8 },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: { code: 'WRITE_CONFLICT', message: 'Concurrent write detected; retry the request' },
    });
  });
});
