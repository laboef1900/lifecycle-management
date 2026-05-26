export class NotFoundError extends Error {
  readonly statusCode = 404;
  readonly code = 'NOT_FOUND';

  constructor(resource: string, id: string) {
    super(`${resource} ${id} not found`);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends Error {
  readonly statusCode = 409;
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ConflictError';
    this.code = code;
  }
}

export class UnprocessableError extends Error {
  readonly statusCode = 422;
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'UnprocessableError';
    this.code = code;
  }
}
