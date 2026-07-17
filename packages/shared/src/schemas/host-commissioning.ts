import { z } from 'zod';

import { cuid, dateOnly } from './common.js';

/**
 * Bulk-confirm the provisional commissioning date on synced hosts (#194, Q9c).
 *
 * vCenter cannot tell us when a host was commissioned, so sync stamps a
 * provisional date (`commissionedAt: new Date()`) and flags it
 * (`commissionedAtProvisional`). An admin then reviews each host and confirms
 * the real date; confirming clears the flag. A fleet import creates many
 * provisional hosts at once, so this is a single TRANSACTIONAL batch: one bad
 * date — rejected by the same `INVALID_COMMISSIONED_AT` guard as
 * `PUT /api/hosts/:id` — aborts the whole batch, never a partial commit.
 *
 * @ai-note Versioning is N/A: this is an internal boundary with a single
 * consumer (the confirm dialog). Errors reuse `INVALID_COMMISSIONED_AT`. The
 * array is bounded — the 1 MiB body limit is not a substitute — and host ids
 * must be unique so no two entries write the same host with an ambiguous
 * last-wins result.
 */
export const HOST_COMMISSIONING_CONFIRM_MAX = 500;

export const hostCommissioningConfirmEntrySchema = z.strictObject({
  hostId: cuid,
  commissionedAt: dateOnly,
});

export const hostCommissioningConfirmInputSchema = z
  .strictObject({
    hosts: z.array(hostCommissioningConfirmEntrySchema).min(1).max(HOST_COMMISSIONING_CONFIRM_MAX),
  })
  .refine((data) => new Set(data.hosts.map((h) => h.hostId)).size === data.hosts.length, {
    message: 'Each host may appear at most once',
    path: ['hosts'],
  });

export type HostCommissioningConfirmInput = z.infer<typeof hostCommissioningConfirmInputSchema>;
