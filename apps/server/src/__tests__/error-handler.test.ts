import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { buildServer } from '../server.js';
import { errorHandlerPlugin as errorHandler } from '../plugins/error-handler.js';
import {
  ConflictError,
  NotFoundError,
  UnauthenticatedError,
  UnprocessableError,
} from '../services/errors.js';
import { makeFakePrisma, makeTestEnv } from './test-helpers.js';

describe('error handler', () => {
  const created: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    while (created.length) {
      const server = created.pop();
      await server?.close();
    }
  });

  it('translates ZodError thrown in a handler into a 400 with the uniform error shape', async () => {
    const server = await buildServer({ env: makeTestEnv(), prisma: makeFakePrisma() });
    created.push(server);

    const schema = z.object({ name: z.string().min(1) });
    server.post('/test-validation', async (request) => {
      schema.parse(request.body);
      return { ok: true };
    });

    const response = await server.inject({
      method: 'POST',
      url: '/test-validation',
      payload: { name: '' },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json() as { error: { code: string; message: string; details: unknown } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toBe('Request validation failed');
    expect(body.error.details).toBeDefined();
  });

  it('returns 404 with the uniform error shape for unknown routes', async () => {
    const server = await buildServer({ env: makeTestEnv(), prisma: makeFakePrisma() });
    created.push(server);

    const response = await server.inject({ method: 'GET', url: '/does-not-exist' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: {
        code: 'NOT_FOUND',
        message: 'Route GET /does-not-exist not found',
      },
    });
  });

  it('hides 500 error messages from clients but logs the original', async () => {
    const server = await buildServer({ env: makeTestEnv(), prisma: makeFakePrisma() });
    created.push(server);

    server.get('/boom', async () => {
      throw new Error('sensitive internal detail');
    });

    const response = await server.inject({ method: 'GET', url: '/boom' });

    expect(response.statusCode).toBe(500);
    const body = response.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.message).toBe('Internal server error');
    expect(body.error.message).not.toContain('sensitive internal detail');
  });
});

describe('ServiceError narrowing', () => {
  let app: ReturnType<typeof Fastify> | undefined;

  afterEach(() => app?.close());

  it('maps ConflictError to its status and code via instanceof', async () => {
    app = Fastify();
    await app.register(errorHandler);
    app.get('/boom', () => {
      throw new ConflictError('CLUSTER_NAME_TAKEN', 'name already in use');
    });
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: { code: 'CLUSTER_NAME_TAKEN', message: 'name already in use' },
    });
  });

  it('maps NotFoundError to 404 NOT_FOUND', async () => {
    app = Fastify();
    await app.register(errorHandler);
    app.get('/missing', () => {
      throw new NotFoundError('Cluster', 'abc');
    });
    const res = await app.inject({ method: 'GET', url: '/missing' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Cluster abc not found' } });
  });

  it('maps UnprocessableError to 422 with its code', async () => {
    app = Fastify();
    await app.register(errorHandler);
    app.get('/unprocessable', () => {
      throw new UnprocessableError('UNKNOWN_METRIC', 'Unknown metric cpu_cores');
    });
    const res = await app.inject({ method: 'GET', url: '/unprocessable' });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({
      error: { code: 'UNKNOWN_METRIC', message: 'Unknown metric cpu_cores' },
    });
  });
});

describe('UnauthenticatedError', () => {
  const created: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    while (created.length) {
      const server = created.pop();
      await server?.close();
    }
  });

  it('maps to a 401 UNAUTHENTICATED envelope', async () => {
    const server = await buildServer({ env: makeTestEnv(), prisma: makeFakePrisma() });
    created.push(server);
    server.get('/boom-unauthenticated', async () => {
      throw new UnauthenticatedError();
    });

    const response = await server.inject({ method: 'GET', url: '/boom-unauthenticated' });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: { code: 'UNAUTHENTICATED', message: 'Authentication required' },
    });
  });
});
