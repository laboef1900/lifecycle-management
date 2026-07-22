import { authMeResponseSchema, type AuthMeResponse } from '@lcm/shared';
import { useRouteContext } from '@tanstack/react-router';

export type AuthState = AuthMeResponse;

/**
 * True when `auth` may perform mutations. In AUTH_MODE=disabled
 * (authRequired=false) there is no session user and everyone is treated as
 * ADMIN, matching the server's anonymous-ADMIN principal. In oidc mode it
 * reflects the signed-in user's role.
 *
 * UX affordance only: the server is the real enforcement point — mutations 403
 * for non-admins regardless of what the UI shows. Exported (rather than kept
 * private to `useIsAdmin`) so route `beforeLoad` guards — which run outside
 * React and cannot call hooks — can apply the identical predicate against
 * `context.auth` (see `routes/_app.settings.access.tsx`).
 */
export function isAdmin(auth: AuthState): boolean {
  if (!auth.authRequired) return true;
  return auth.user?.role === 'ADMIN';
}

/**
 * True when the current principal may perform mutations. See `isAdmin` for
 * the predicate itself; this hook just supplies it with the router's `auth`
 * context.
 */
export function useIsAdmin(): boolean {
  const { auth } = useRouteContext({ from: '__root__' });
  return isAdmin(auth);
}

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
