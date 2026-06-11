import type { FastifyError, FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { ZodError } from 'zod';

import { ServiceError } from '../services/errors.js';

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

const errorHandlerPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof ZodError) {
      request.log.warn({ issues: error.issues }, 'Request validation failed');
      const body: ApiErrorBody = {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: error.flatten(),
        },
      };
      reply.status(400).send(body);
      return;
    }

    if (error.validation) {
      request.log.warn({ validation: error.validation }, 'Schema validation failed');
      const body: ApiErrorBody = {
        error: {
          code: 'VALIDATION_ERROR',
          message: error.message,
          details: error.validation,
        },
      };
      reply.status(error.statusCode ?? 400).send(body);
      return;
    }

    if (error instanceof ServiceError) {
      request.log.warn({ err: error }, 'Service error');
      const body: ApiErrorBody = {
        error: { code: error.code, message: error.message },
      };
      reply.status(error.statusCode).send(body);
      return;
    }

    const statusCode = error.statusCode ?? 500;

    if (statusCode >= 500) {
      request.log.error({ err: error }, 'Unhandled error');
    } else {
      request.log.warn({ err: error }, 'Client error');
    }

    const body: ApiErrorBody = {
      error: {
        code: error.code ?? (statusCode >= 500 ? 'INTERNAL_ERROR' : 'CLIENT_ERROR'),
        message: statusCode >= 500 ? 'Internal server error' : error.message,
      },
    };
    reply.status(statusCode).send(body);
  });

  fastify.setNotFoundHandler((request, reply) => {
    const body: ApiErrorBody = {
      error: {
        code: 'NOT_FOUND',
        message: `Route ${request.method} ${request.url} not found`,
      },
    };
    reply.status(404).send(body);
  });
};

export default fp(errorHandlerPlugin, { name: 'error-handler' });
