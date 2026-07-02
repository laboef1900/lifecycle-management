import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { HostsService } from '../services/hosts.js';
import { ConflictError } from '../services/errors.js';
import { ItemsService } from '../services/items.js';

import { makeFakePrisma } from './test-helpers.js';

/**
 * Focused unit coverage for the P2034 (serialization failure) -> 409
 * WRITE_CONFLICT mapping added in Task C6. A full concurrent-transaction
 * integration test is intentionally out of scope here (see task report);
 * this exercises `translatePrismaError` directly with a synthetic Prisma
 * error, which is the actual branch that needed to change.
 */
function makeSerializationError(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('could not serialize access', {
    code: 'P2034',
    clientVersion: '6.19.3',
  });
}

interface HasTranslatePrismaError {
  translatePrismaError(err: unknown): void;
}

describe('translatePrismaError P2034 mapping', () => {
  it('HostsService maps P2034 to a 409 WRITE_CONFLICT ConflictError', () => {
    const service = new HostsService(makeFakePrisma()) as unknown as HasTranslatePrismaError;
    const err = makeSerializationError();

    let thrown: unknown;
    try {
      service.translatePrismaError(err);
    } catch (caught) {
      thrown = caught;
    }

    expect(thrown).toBeInstanceOf(ConflictError);
    expect((thrown as ConflictError).statusCode).toBe(409);
    expect((thrown as ConflictError).code).toBe('WRITE_CONFLICT');
  });

  it('ItemsService maps P2034 to a 409 WRITE_CONFLICT ConflictError', () => {
    const service = new ItemsService(makeFakePrisma()) as unknown as HasTranslatePrismaError;
    const err = makeSerializationError();

    let thrown: unknown;
    try {
      service.translatePrismaError(err);
    } catch (caught) {
      thrown = caught;
    }

    expect(thrown).toBeInstanceOf(ConflictError);
    expect((thrown as ConflictError).statusCode).toBe(409);
    expect((thrown as ConflictError).code).toBe('WRITE_CONFLICT');
  });

  it('leaves unrelated errors untranslated (no throw)', () => {
    const service = new HostsService(makeFakePrisma()) as unknown as HasTranslatePrismaError;
    expect(() => service.translatePrismaError(new Error('boom'))).not.toThrow();
  });
});
