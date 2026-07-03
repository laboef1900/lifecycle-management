import type { ServiceErrorCode } from '@lcm/shared';
import { Prisma } from '@prisma/client';

import { ConflictError } from './errors.js';

const PRISMA_SERIALIZATION_FAILURE = 'P2034';
const PRISMA_UNIQUE_CONSTRAINT = 'P2002';

/** Service-specific mapping for a Prisma P2002 unique-constraint violation. */
export interface UniqueConstraintMapping {
  code: ServiceErrorCode;
  message: string;
}

export interface TranslatePrismaErrorOptions {
  uniqueConstraint?: UniqueConstraintMapping;
}

/**
 * Translates known Prisma errors into service-level `ConflictError`s.
 *
 * - P2034 (serialization failure under `Serializable` isolation) always maps
 *   to a 409 `WRITE_CONFLICT` so clients can retry.
 * - P2002 (unique-constraint violation) maps to the caller-supplied
 *   `uniqueConstraint` code/message when provided.
 *
 * Anything else returns normally; callers are expected to rethrow the
 * original error afterwards.
 */
export function translatePrismaError(err: unknown, opts?: TranslatePrismaErrorOptions): void {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) {
    return;
  }
  if (err.code === PRISMA_SERIALIZATION_FAILURE) {
    throw new ConflictError('WRITE_CONFLICT', 'Concurrent write detected; retry the request');
  }
  if (err.code === PRISMA_UNIQUE_CONSTRAINT && opts?.uniqueConstraint) {
    throw new ConflictError(opts.uniqueConstraint.code, opts.uniqueConstraint.message);
  }
}
