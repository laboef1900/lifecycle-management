import { useState } from 'react';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { Activity } from 'lucide-react';
import { z } from 'zod';

import { type LoginErrorCode, loginErrorCodeSchema, safeRedirectPath } from '@lcm/shared';

import { Field } from '@/components/form/field';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { localLogin } from '@/lib/api-client';

const loginSearchSchema = z.object({
  error: z.string().optional(),
  // The path the user was headed to before being bounced here. Two consumers:
  // the OIDC button forwards it to the server (validated there), while the
  // local-login form consumes it client-side and MUST validate it itself with
  // safeRedirectPath before navigating.
  redirect: z.string().optional(),
});

/**
 * Builds the sign-in URL, forwarding the deep-link return path when present.
 * Validation of the target is the server's responsibility (open-redirect
 * defence lives there); this only URL-encodes it.
 */
export function buildLoginHref(redirect: string | undefined): string {
  return redirect ? `/api/auth/login?redirect=${encodeURIComponent(redirect)}` : '/api/auth/login';
}

// Keyed by the shared LoginErrorCode union so a new server code fails the build
// here until copy is added, instead of silently degrading to the generic message.
const ERROR_COPY: Record<LoginErrorCode, string> = {
  login_failed: 'Sign-in failed. Please try again.',
  state_mismatch: 'The sign-in attempt expired or was started in another tab. Please try again.',
  idp_error: 'The identity provider reported an error. Please try again.',
  access_denied: 'Your account is not allowed to access this application.',
  idp_unavailable: 'The identity provider is unreachable right now. Please try again shortly.',
  scheme_mismatch:
    'The server is misconfigured (APP_BASE_URL scheme mismatch). Contact your administrator.',
};

export const Route = createFileRoute('/login')({
  validateSearch: loginSearchSchema,
  beforeLoad: ({ context }) => {
    if (!context.auth.authRequired || context.auth.user) {
      throw redirect({ to: '/' });
    }
  },
  component: LoginPage,
});

/**
 * Username/password sign-in form for local-admin auth (Task 6's
 * `POST /api/auth/local/login`). On a successful submit it triggers a
 * full-page load rather than a client-side navigation: the root `auth`
 * context is fetched once at startup (main.tsx), so only a fresh page load
 * re-bootstraps it with the new session cookie.
 */
export function LocalLoginForm({
  redirectTo,
}: {
  redirectTo: string | undefined;
}): React.JSX.Element {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const ok = await localLogin(username, password);
      if (!ok) {
        setError('Invalid username or password.');
        setPending(false);
        return;
      }
      // The root `auth` context is fetched once at app startup (main.tsx), so a
      // client-side navigate would keep the stale "logged out" state and bounce
      // straight back here. Do a full-page load so the app re-bootstraps auth
      // with the new session cookie — mirrors how the OIDC flow returns via a
      // full navigation. safeRedirectPath rejects anything that isn't a
      // same-origin path (backslash/control-char/protocol-relative bypasses
      // included), so an attacker-supplied ?redirect= can't open-redirect us.
      const dest = safeRedirectPath(redirectTo) ?? '/';
      // Deliberately leave `pending` true: the page is unloading, and resetting
      // it would flash the button back to enabled and permit a duplicate submit
      // during the navigation window.
      window.location.assign(dest);
    } catch {
      // localLogin() rejecting (offline/DNS/CORS) — without this, `pending`
      // would stay stuck at `true` (button pinned to "Signing in…") with no
      // feedback shown.
      setError('Something went wrong. Please try again.');
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      {error ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}
      <Field
        label="Username"
        id="username"
        name="username"
        autoComplete="username"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        required
      />
      <Field
        label="Password"
        id="password"
        name="password"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
      />
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? 'Signing in…' : 'Sign in'}
      </Button>
    </form>
  );
}

function LoginPage(): React.JSX.Element {
  const { error, redirect } = Route.useSearch();
  const { auth } = Route.useRouteContext();
  const parsedError = loginErrorCodeSchema.safeParse(error);
  const message = parsedError.success
    ? ERROR_COPY[parsedError.data]
    : error
      ? ERROR_COPY.login_failed
      : undefined;
  const loginHref = buildLoginHref(redirect);
  // Older `/api/auth/me` responses (pre-Task-1) omit `loginMethods` entirely —
  // treat that as the original OIDC-only behaviour so nothing regresses.
  const showLocal = auth.loginMethods?.local === true;
  const showOidc = auth.loginMethods ? auth.loginMethods.oidc : true;
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 text-foreground">
      <Card className="w-full max-w-sm p-8">
        <div className="mb-6 flex items-center gap-2.5 font-semibold">
          <span
            aria-hidden
            className="flex h-7 w-7 items-center justify-center rounded-[var(--radius)] bg-accent"
          >
            <Activity className="h-4 w-4 text-accent-foreground" />
          </span>
          <span>Capacity Forecast</span>
        </div>
        {message ? (
          <p
            role="alert"
            className="mb-4 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {message}
          </p>
        ) : null}
        {showLocal ? (
          <>
            <p className="mb-4 text-sm text-muted-foreground">Sign in with your admin account.</p>
            <LocalLoginForm redirectTo={redirect} />
          </>
        ) : null}
        {showLocal && showOidc ? (
          <div className="my-5 flex items-center gap-3 text-xs uppercase tracking-wide text-fg-subtle">
            <span className="h-px flex-1 bg-border" />
            <span>or</span>
            <span className="h-px flex-1 bg-border" />
          </div>
        ) : null}
        {showOidc ? (
          <>
            {!showLocal ? (
              <p className="mb-6 text-sm text-muted-foreground">
                Sign in with your organization account to continue.
              </p>
            ) : null}
            <Button asChild className="w-full" variant={showLocal ? 'outline' : 'default'}>
              <a href={loginHref}>Sign in{showLocal ? ' with SSO' : ''}</a>
            </Button>
          </>
        ) : null}
      </Card>
    </div>
  );
}
