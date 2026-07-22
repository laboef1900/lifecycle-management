import { z } from 'zod';

/**
 * Client-supplied idempotency key for a mutating request that must be safe to
 * retry: a UUID v4 minted once per user action and reused across retries of
 * that SAME action (never across a genuinely new one). Sent as the
 * `Idempotency-Key` request header, never a body field — it describes the
 * request's delivery, not its domain payload, so it stays out of every
 * mutating endpoint's own Zod input schema.
 */
export const idempotencyKeyHeaderSchema = z.string().uuid();
