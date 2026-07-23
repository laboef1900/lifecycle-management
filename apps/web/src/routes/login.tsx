import { useState } from 'react';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { Check, ShieldCheck } from 'lucide-react';
import { z } from 'zod';

import { type LoginErrorCode, loginErrorCodeSchema, safeRedirectPath } from '@lcm/shared';

import { Field } from '@/components/form/field';
import { BrandMark } from '@/components/ui/brand-mark';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { localLogin } from '@/lib/api-client';
import { cn } from '@/lib/utils';

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
    <form onSubmit={onSubmit} className="space-y-4">
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
      {/* `variant="accent"` matches the app-wide primary-CTA convention (every
          other submit button in settings/dialogs uses it) and the house style's
          "amber --accent for brand + CTAs". @ai-warning this must stay the only
          <button> inside this form: login-local.test.tsx's last case queries a
          bare getByRole('button'), which throws on multiple matches — a
          password show/hide toggle is the obvious temptation here. */}
      <Button type="submit" variant="accent" size="lg" className="w-full" disabled={pending}>
        {pending ? 'Signing in…' : 'Sign in'}
      </Button>
    </form>
  );
}

// Owner-approved copy (2026-07-20) — implement verbatim, don't re-derive.
const HERO_POINTS = [
  'Runs on your infrastructure',
  'Every forecast is traceable',
  'Live vSphere sync',
  'Role-based access',
] as const;

/**
 * Brand panel of the split-screen layout. Purely presentational: it carries no
 * control needed to sign in, which is what lets it drop out entirely below
 * `lg` (the sign-in card is the priority on a phone).
 *
 * @ai-warning must never contain a link whose accessible name matches
 * /sign in/i — three OIDC e2e specs resolve the SSO control with
 * `getByRole('link', { name: /sign in/i })` under Playwright strict mode, and a
 * second match fails the whole `oidc-e2e` job.
 */
export function LoginHero(): React.JSX.Element {
  return (
    <aside className="login-hero relative hidden flex-col justify-between overflow-hidden border-r border-border p-10 lg:flex xl:p-14">
      <div className="flex items-center gap-2.5 font-display font-semibold">
        <BrandMark className="h-8 w-8" />
        <span>Capacity Forecast</span>
      </div>

      <div className="max-w-xl">
        {/* Opaque chip, not the accent-soft `Badge` variant: over the light
            hero's warm wash that variant measures 3.57:1 for the amber label —
            under the 4.5:1 floor. On the card surface it is 5.26:1 light /
            10.86:1 dark. */}
        <span className="inline-flex items-center gap-2 rounded-full border border-accent/30 bg-card px-3 py-1 text-xs font-medium text-accent shadow-[var(--shadow-card)]">
          <ShieldCheck aria-hidden className="h-3.5 w-3.5" />
          Secure capacity intelligence
        </span>

        {/* A display-styled paragraph rather than a heading: the hero is
            decorative and hidden below `lg`, so an <h1> here would leave the
            page with no h1 at all on a phone. The sign-in card owns the h1. */}
        <p className="mt-7 font-display text-4xl font-semibold leading-[1.08] tracking-[-0.025em] xl:text-5xl">
          Capacity you can see coming.
        </p>
        <p className="mt-5 max-w-lg text-base leading-relaxed text-fg-muted">
          Memory-capacity forecasting for your vSphere fleet — one source of truth for every
          purchasing decision.
        </p>

        {/* Each tick is paired with its label, so the list never leans on color
            alone to carry meaning (SC 1.4.1). */}
        <ul className="mt-10 grid grid-cols-2 gap-x-6 gap-y-4">
          {HERO_POINTS.map((point) => (
            <li key={point} className="flex items-start gap-2.5 text-sm">
              <Check aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-success" />
              <span>{point}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* Balances the flex column against the brand lockup so the content block
          sits optically centred. */}
      <div aria-hidden />
    </aside>
  );
}

/**
 * The sign-in card. Split out of `LoginPage` (which is bound to the router via
 * `Route.useSearch`/`useRouteContext`) so the three auth states — local-only,
 * SSO-only, and both — are directly renderable in the colocated RTL tests.
 */
export function SignInCard({
  message,
  showLocal,
  showOidc,
  loginHref,
  redirectTo,
}: {
  message: string | undefined;
  showLocal: boolean;
  showOidc: boolean;
  loginHref: string;
  redirectTo: string | undefined;
}): React.JSX.Element {
  return (
    <Card className="w-full p-8">
      <BrandMark className="h-10 w-10" />
      <p className="mt-6 text-xs font-medium uppercase tracking-[0.12em] text-fg-subtle">
        Welcome back
      </p>
      <h1 className="mt-3 font-display text-2xl font-semibold tracking-[-0.02em]">
        Sign in to Capacity Forecast
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {showLocal
          ? 'Sign in with your admin account.'
          : 'Sign in with your organization account to continue.'}
      </p>

      {message ? (
        <p
          role="alert"
          className="mt-6 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {message}
        </p>
      ) : null}

      {showLocal ? (
        <div className="mt-6">
          <LocalLoginForm redirectTo={redirectTo} />
        </div>
      ) : null}

      {/* Only ever rendered between two controls — local-only and SSO-only both
          render with no orphaned separator. */}
      {showLocal && showOidc ? (
        <div className="my-6 flex items-center gap-3 text-xs uppercase tracking-wide text-fg-subtle">
          <span className="h-px flex-1 bg-border" />
          <span>or</span>
          <span className="h-px flex-1 bg-border" />
        </div>
      ) : null}

      {showOidc ? (
        // @ai-warning stays an anchor, never a <button>: it is a plain GET
        // navigation to /api/auth/login, and playwright-oidc/oidc-auth.spec.ts
        // + layout.spec.ts select it by the *link* role.
        <Button
          asChild
          size="lg"
          className={cn('w-full', showLocal ? undefined : 'mt-6')}
          variant={showLocal ? 'outline' : 'accent'}
        >
          <a href={loginHref}>Sign in{showLocal ? ' with SSO' : ''}</a>
        </Button>
      ) : null}
    </Card>
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
  // treat that as the original OIDC-only behaviour so nothing regresses. Do NOT
  // tighten this to `auth.loginMethods?.oidc === true`: that would leave those
  // deployments with no sign-in control at all (#257).
  const showLocal = auth.loginMethods?.local === true;
  const showOidc = auth.loginMethods ? auth.loginMethods.oidc : true;
  return (
    <div className="grid min-h-screen grid-cols-1 bg-background text-foreground lg:grid-cols-[1.05fr_1fr]">
      <LoginHero />
      <main className="flex items-center justify-center px-4 py-12 sm:px-8">
        <div className="w-full max-w-md">
          <SignInCard
            message={message}
            showLocal={showLocal}
            showOidc={showOidc}
            loginHref={loginHref}
            redirectTo={redirect}
          />
          <p className="mt-6 text-center text-xs text-fg-subtle">
            Protected workspace · access is logged
          </p>
        </div>
      </main>
    </div>
  );
}
