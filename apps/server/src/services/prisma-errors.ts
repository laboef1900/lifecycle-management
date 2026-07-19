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

/**
 * The Prisma model whose unique constraint a P2002 violated, or `undefined` when
 * `err` is not a unique-constraint violation.
 *
 * Lets a caller whose write touches more than one table tell WHICH conflict it
 * hit — reporting a baseline-period collision as `A cluster named "" already
 * exists` sends the operator after the wrong problem.
 *
 * @ai-warning `meta.modelName` is the discriminator because Prisma 7's driver
 * adapters report no `meta.target`. A real P2002 from `@prisma/adapter-pg`
 * carries `{ modelName, driverAdapterError: { cause: { originalCode: '23505',
 * constraint: { fields: [...] } } } }`. That shape is pinned against a genuine
 * Postgres violation in `prisma-errors.test.ts` rather than assumed — if a
 * Prisma upgrade moves it, that test fails loudly instead of every caller
 * silently falling through to a sanitized 500.
 *
 * @ai-warning DIRECT WRITES ONLY. `modelName` names the model of the INVOCATION,
 * not the table whose index was violated, so a nested write reports the top-level
 * model: `cluster.create({ data: { baselineHistory: { create: [...] } } })`
 * breaching `cluster_baseline_history_period_unique` answers `Cluster`, which is
 * indistinguishable from a duplicate cluster name. Both behaviours are pinned in
 * `prisma-errors.test.ts`. Do not reach for this in a nested-write catch block —
 * refuse the condition before the write instead (`ClustersService.create` is the
 * worked example).
 */
export function uniqueConstraintModel(err: unknown): string | undefined {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) {
    return undefined;
  }
  if (err.code !== PRISMA_UNIQUE_CONSTRAINT) {
    return undefined;
  }
  const modelName: unknown = err.meta?.['modelName'];
  return typeof modelName === 'string' ? modelName : undefined;
}
