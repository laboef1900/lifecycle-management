import { z } from 'zod';

import { cuid, dateOnly } from './common.js';

export const hostReplacementCreateInputSchema = z.object({
  oldHostId: cuid,
  newHostId: cuid,
  swappedAt: dateOnly,
  reason: z.string().trim().max(2000).optional(),
});
export type HostReplacementCreateInput = z.infer<typeof hostReplacementCreateInputSchema>;

export const hostReplacementIdParamsSchema = z.object({ id: cuid });

export interface HostReplacementResponse {
  id: string;
  oldHostId: string;
  newHostId: string;
  swappedAt: string;
  reason: string | null;
  createdAt: string;
}
