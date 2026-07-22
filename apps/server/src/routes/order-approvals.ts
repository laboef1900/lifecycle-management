import type { FastifyPluginAsync } from 'fastify';

import { orderApprovalCreateInputSchema, orderApprovalParamsSchema } from '@lcm/shared';

import { UnauthenticatedError } from '../services/errors.js';
import { OrderApprovalService } from '../services/order-approval.js';

/**
 * Order-approval routes (#292). The POST is a mutating `/api` route, so the auth
 * plugin's `requiresAdmin` hook ADMIN-gates it by construction (VIEWER → 403);
 * it is deliberately NOT in the read-only-mutation exemption set. The response
 * is a 201 with the immutable snapshot; the acknowledgment itself surfaces on
 * the forecast response, so there is no read route here.
 */
export const orderApprovalRoutes: FastifyPluginAsync = async (fastify) => {
  const service = new OrderApprovalService(fastify.prisma);

  fastify.post('/clusters/:id/order-approvals', async (request, reply) => {
    const { id } = orderApprovalParamsSchema.parse(request.params);
    const input = orderApprovalCreateInputSchema.parse(request.body);

    // Non-null by construction on this path (the auth plugin sets the anonymous
    // principal in disabled mode and throws 401 otherwise, before the admin
    // gate), but narrow it explicitly rather than assert — the audit label and
    // user id come from here.
    const principal = request.user;
    if (!principal) throw new UnauthenticatedError();

    const created = await service.create(request.tenantId, id, input, principal);
    reply.status(201);
    return created;
  });
};
