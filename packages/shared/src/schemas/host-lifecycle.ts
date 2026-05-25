import { z } from 'zod';

import { dateOnly } from './common.js';

export const HOST_STATES = [
  'ordered',
  'racked',
  'in_service',
  'degraded',
  'decommissioned',
  'disposed',
] as const;

export const hostStateSchema = z.enum(HOST_STATES);
export type HostState = z.infer<typeof hostStateSchema>;

export const hostTransitionInputSchema = z.object({
  toState: hostStateSchema,
  occurredAt: dateOnly,
  note: z.string().trim().max(2000).optional(),
});
export type HostTransitionInput = z.infer<typeof hostTransitionInputSchema>;

export interface HostLifecycleEventResponse {
  id: string;
  hostId: string;
  fromState: HostState | null;
  toState: HostState;
  occurredAt: string;
  note: string | null;
  createdAt: string;
}
