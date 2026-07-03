import { z } from 'zod';

export const authUserSchema = z.object({
  id: z.string(),
  email: z.string().nullable(),
  displayName: z.string().nullable(),
  role: z.enum(['ADMIN', 'VIEWER']),
});

/**
 * Response of GET /api/auth/me — the SPA's single source of truth.
 * authRequired=false means AUTH_MODE=disabled (app runs unauthenticated).
 * user is present only for an authenticated session.
 */
export const authMeResponseSchema = z.object({
  authRequired: z.boolean(),
  user: authUserSchema.optional(),
});

export type AuthUser = z.infer<typeof authUserSchema>;
export type AuthMeResponse = z.infer<typeof authMeResponseSchema>;
