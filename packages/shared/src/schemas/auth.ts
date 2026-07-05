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

/**
 * Codes the server appends to `/login?error=<code>` when an OIDC login fails.
 * Shared so the server (which emits them) and the web login page (which maps
 * each to user-facing copy) can't drift — a new code forces a matching entry
 * in the web's ERROR_COPY map.
 */
export const loginErrorCodeSchema = z.enum([
  'login_failed',
  'state_mismatch',
  'idp_error',
  'access_denied',
  'idp_unavailable',
  'scheme_mismatch',
]);
export type LoginErrorCode = z.infer<typeof loginErrorCodeSchema>;
