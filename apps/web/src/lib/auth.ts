import { authMeResponseSchema, type AuthMeResponse } from '@lcm/shared';

export type AuthState = AuthMeResponse;

/**
 * One bootstrap fetch before the router renders. Fails closed: any error is
 * treated as "auth required, not signed in", which lands on /login — the
 * server remains the actual enforcement point either way.
 */
export async function fetchAuthState(): Promise<AuthState> {
  try {
    const response = await fetch('/api/auth/me', {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return { authRequired: true };
    const parsed = authMeResponseSchema.safeParse(await response.json());
    return parsed.success ? parsed.data : { authRequired: true };
  } catch {
    return { authRequired: true };
  }
}
