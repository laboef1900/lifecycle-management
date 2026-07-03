import type { ServiceErrorCode } from '@lcm/shared';

/** Base for all service-thrown HTTP errors; the error handler narrows on it. */
export abstract class ServiceError extends Error {
  abstract readonly statusCode: number;
  readonly code: ServiceErrorCode;

  protected constructor(code: ServiceErrorCode, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export class NotFoundError extends ServiceError {
  readonly statusCode = 404;

  constructor(resource: string, id: string) {
    super('NOT_FOUND', `${resource} ${id} not found`);
  }
}

export class ConflictError extends ServiceError {
  readonly statusCode = 409;

  constructor(code: ServiceErrorCode, message: string) {
    super(code, message);
  }
}

export class UnprocessableError extends ServiceError {
  readonly statusCode = 422;

  constructor(code: ServiceErrorCode, message: string) {
    super(code, message);
  }
}

export class UnauthenticatedError extends ServiceError {
  readonly statusCode = 401;

  constructor() {
    super('UNAUTHENTICATED', 'Authentication required');
  }
}
