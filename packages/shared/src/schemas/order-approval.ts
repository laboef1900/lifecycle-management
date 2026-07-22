import { z } from 'zod';

import { cuid } from './common.js';

/**
 * Body for `POST /api/clusters/:id/order-approvals` (#292). The only client
 * input is an optional free-text note; every snapshotted field (breach month,
 * order-by date, lead time, warn threshold, capacity signature, audit label) is
 * derived server-side from the live forecast at approval time so the client can
 * never forge the acknowledged episode. `≤2000` chars, React-escaped on render,
 * never `dangerouslySetInnerHTML` (DESIGN.md §8).
 */
export const orderApprovalCreateInputSchema = z.object({
  note: z.string().trim().max(2000).optional(),
});
export type OrderApprovalCreateInput = z.infer<typeof orderApprovalCreateInputSchema>;

export const orderApprovalParamsSchema = z.object({ id: cuid });

/**
 * A persisted, immutable order-approval snapshot (DESIGN.md §4). Returned by the
 * create endpoint (201). Dates are wire dates (`YYYY-MM-DD`); `createdAt` is an
 * ISO instant. `approvedByUserId` is nullable — in `AUTH_MODE=disabled` the
 * anonymous ADMIN principal has no `users` row, so the audit trail is carried by
 * `approvedByLabel` (DESIGN.md §7).
 */
export interface OrderApprovalResponse {
  id: string;
  clusterId: string;
  breachMonth: string;
  orderByDate: string;
  leadTimeWeeks: number;
  warnThreshold: number;
  capacitySignature: number;
  approvedByUserId: string | null;
  approvedByLabel: string;
  note: string | null;
  createdAt: string;
}
