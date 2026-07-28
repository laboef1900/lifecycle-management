import { useDeferredValue, useState } from 'react';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { Check, ShieldCheck, TriangleAlert, Unlock } from 'lucide-react';
import { z } from 'zod';

import { type LoginErrorCode, loginErrorCodeSchema, safeRedirectPath } from '@lcm/shared';

import { Field } from '@/components/form/field';
import { ThemeToggle } from '@/components/theme/theme-toggle';
import { BrandMark } from '@/components/ui/brand-mark';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { localLogin, type LocalLoginResult } from '@/lib/api-client';
import { cn } from '@/lib/utils';

/**
 * @ai-warning Disclosure boundary for this route. `/login` is the app's only
 * pre-authentication surface, so it renders NOTHING the visitor did not already
 * supply or the server does not already return unauthenticated: the address bar
 * host, `isSecureContext`, `auth.loginMethods` (already in `GET /api/auth/me`
 * for anonymous callers), the closed `?error=` enum, and a `safeRedirectPath`-
 * validated `?redirect=`. It makes no new API call and adds no field to
 * `authMeResponseSchema`.
 *
 * Never render here: app version / build id, vCenter host or fingerprint,
 * cluster or capacity values, sync timestamps, usernames or the local-admin
 * count, the OIDC issuer / client id / allow-list, the server's own hostname,
 * or any log excerpt or IdP `error_description` (the server deliberately logs
 * and withholds that one).
 */

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
// here until copy is added. Copy rule: name the condition, then the recovery —
// and never say "try again" where retrying cannot work.
const ERROR_COPY: Record<LoginErrorCode, string> = {
  login_failed:
    'Sign-in couldn’t be completed after returning from the identity provider. Try again from this page.',
  state_mismatch:
    'This sign-in attempt expired, or it was started in a different browser or tab. Start again from this page.',
  idp_error:
    'Your identity provider rejected the sign-in. The reason was recorded in the server log — ask an administrator to check it.',
  access_denied:
    'That account isn’t allowed to use this deployment. Ask an administrator to add it to the sign-in allow-list.',
  idp_unavailable:
    'This server can’t reach the identity provider right now. It retries automatically — try again in a moment, and tell an administrator if it persists.',
  scheme_mismatch:
    'Sign-in was stopped: this server’s configured base URL uses a different scheme (http or https) than the address you reached it on. An administrator needs to correct it in Settings → Authentication.',
};

// A code this build does not know is its own condition, not a `login_failed`
// in disguise — an older/newer server, or a hand-edited URL.
const UNRECOGNISED_ERROR_COPY = 'Sign-in didn’t complete. Try again from this page.';

/**
 * Maps the `?error=` query value to copy.
 *
 * @ai-warning never render the raw code — it is unbounded, attacker-controlled
 * query text. Unknown codes collapse to one fixed string.
 */
export function loginErrorMessage(error: string | undefined): string | undefined {
  if (error === undefined || error === '') return undefined;
  const parsed = loginErrorCodeSchema.safeParse(error);
  return parsed.success ? ERROR_COPY[parsed.data] : UNRECOGNISED_ERROR_COPY;
}

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
 * Sentinel for the first render pass of `AlertSlot`.
 *
 * @ai-warning must not be `undefined`: React treats an `undefined`
 * `initialValue` as "argument omitted" and skips the deferral entirely, which
 * would collapse the two-pass render below back into one.
 */
const ALERT_NOT_YET_ANNOUNCED = Symbol('alert-not-yet-announced');

/**
 * The page's one alert slot. There is exactly one on screen at any time: in the
 * local modes the form owns it (and folds any server `?error=` message into the
 * same slot), in SSO-only mode the plate renders it directly.
 *
 * @ai-warning the live region is rendered ALWAYS and EMPTY, and the banner
 * arrives on a later pass. A `role="alert"` that is already present at first
 * paint is not reliably announced — alerts announce on insertion *after* the
 * region exists, and React commits a wrapper and its content in the same pass,
 * so a persistent-wrapper-only fix does not help either. `useDeferredValue`
 * with an explicit initial value gives that second pass without a
 * setState-in-effect (which `react-hooks/set-state-in-effect` rejects, rightly:
 * this is a render concern, not an external-system sync). Do NOT move focus
 * here — that interrupts the announcement and strands the user away from the
 * field they need to fix.
 */
function AlertSlot({
  message,
  className,
}: {
  message: string | undefined;
  className?: string;
}): React.JSX.Element {
  const deferred = useDeferredValue<string | undefined | typeof ALERT_NOT_YET_ANNOUNCED>(
    message,
    ALERT_NOT_YET_ANNOUNCED,
  );
  const announced = deferred === ALERT_NOT_YET_ANNOUNCED ? undefined : deferred;

  return (
    <div aria-live="assertive" aria-atomic="true" className="min-h-0">
      {announced === undefined ? null : (
        <p
          role="alert"
          className={cn(
            // 8px (--radius), the control radius — the banner sits in the
            // control column of the plate. The old `rounded-md` (6px) was off
            // the 8 / 14 / 16 / pill vocabulary.
            'flex items-start gap-2 rounded-[var(--radius)] border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive',
            // The surface's one authored moment. The global reduced-motion rule
            // in styles.css zeroes it — no per-component handling needed.
            'duration-150 animate-in fade-in slide-in-from-top-1',
            className,
          )}
        >
          {/* Icon pairs shape with the red so the error never leans on color
              alone (SC 1.4.1); aria-hidden — the text carries the meaning. */}
          <TriangleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{announced}</span>
        </p>
      )}
    </div>
  );
}

// One string per non-`ok` localLogin result. `invalid` stays deliberately
// undifferentiated so the form never reveals whether a username exists.
const LOCAL_LOGIN_FAILURE_COPY: Record<Exclude<LocalLoginResult, 'ok'>, string> = {
  invalid: 'Invalid username or password.',
  rate_limited: 'Too many sign-in attempts. Wait a minute, then try again.',
  error:
    'The server rejected the sign-in request. Try again shortly — an administrator can check the server log.',
};

// localLogin only rejects on a network-level failure; every HTTP status
// resolves to a LocalLoginResult above.
const LOCAL_LOGIN_UNREACHABLE_COPY =
  'Couldn’t reach the server. Check your connection, then try again.';

/**
 * Username/password sign-in form for local accounts (`POST
 * /api/auth/local/login`). On a successful submit it triggers a full-page load
 * rather than a client-side navigation: the root `auth` context is fetched once
 * at startup (main.tsx), so only a fresh page load re-bootstraps it with the new
 * session cookie.
 *
 * @ai-warning nothing reachable from here may read `window.location` beyond
 * `assign()`: login-local.test.tsx stubs `location` as `{ assign, href, origin }`
 * with no `host`. The page's ambient facts are read once in `LoginPage` and
 * passed down as props.
 */
export function LocalLoginForm({
  redirectTo,
  serverMessage,
}: {
  redirectTo: string | undefined;
  serverMessage?: string | undefined;
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
      const result = await localLogin(username, password);
      if (result !== 'ok') {
        setError(LOCAL_LOGIN_FAILURE_COPY[result]);
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
      setError(LOCAL_LOGIN_UNREACHABLE_COPY);
      setPending(false);
    }
  }

  return (
    // Named by the plate's h1 rather than a second visible heading, so the page
    // keeps exactly one <h1> in every mode.
    <form onSubmit={onSubmit} aria-labelledby="login-title">
      <AlertSlot message={error ?? serverMessage} className="mb-4" />
      <div className="space-y-4">
        <Field
          label="Username"
          id="username"
          name="username"
          autoComplete="username"
          // The fast path: a returning operator lands ready to type. Safe here
          // because the form is the whole reason the page exists.
          autoFocus
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          // h-9 matches the submit button (Button size="lg"); the shared Input
          // default is h-8. `cn()` is twMerge, so this overrides cleanly with no
          // change to the shared primitive. bg-card keeps the field visible in
          // light theme, where Input's bg-background + #dce2ee hairline is
          // invisible on a bare --background page; dark keeps the recessed well.
          className="h-9 bg-card dark:bg-background"
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
          className="h-9 bg-card dark:bg-background"
          required
        />
        {/* `variant="accent"` matches the app-wide primary-CTA convention (every
            other submit button in settings/dialogs uses it): under cool-brand,
            `--accent` is the steel brand + CTA hue, so this renders steel, not
            the retired amber. @ai-warning this must stay the only <button>
            inside this form: login-local.test.tsx's last case queries a bare
            getByRole('button'), which throws on multiple matches — a password
            show/hide toggle is the obvious temptation here. */}
        <Button type="submit" variant="accent" size="lg" className="w-full" disabled={pending}>
          {pending ? 'Signing in…' : 'Sign in'}
        </Button>
      </div>
    </form>
  );
}

/** What the deployment accepts, stated plainly rather than implied by controls. */
type AccessMode = 'local' | 'oidc' | 'both' | 'none' | 'unknown';

const ACCESS_COPY: Record<AccessMode, string> = {
  local: 'Local accounts',
  oidc: 'Identity provider (SSO)',
  both: 'Local accounts or SSO',
  // Reachable: mode is `local` with every local account disabled. Known to be
  // nothing is not the same as unknown, so it gets its own honest string.
  none: 'None configured',
  unknown: 'Unknown',
};

/**
 * `fetchAuthState()` fails closed to `{ authRequired: true }` with NO
 * `loginMethods`, so an unreachable API lands on the SSO fallback below and the
 * page would otherwise render an SSO control that may already be dead. Saying
 * "Unknown" is Product Principle 4 (honest uncertainty) on the login screen.
 */
function accessMode(showLocal: boolean, showOidc: boolean, methodsKnown: boolean): AccessMode {
  if (!methodsKnown) return 'unknown';
  if (showLocal && showOidc) return 'both';
  if (showLocal) return 'local';
  if (showOidc) return 'oidc';
  return 'none';
}

// Hard cap on the rendered return path, so an attacker-chosen (but same-origin
// and therefore safeRedirectPath-accepted) path cannot compose a misleading
// sentence inside the plate. Rendered as text, never as a link.
const RETURN_PATH_MAX_CHARS = 40;

function truncateReturnPath(path: string): string {
  return path.length <= RETURN_PATH_MAX_CHARS
    ? path
    : `${path.slice(0, RETURN_PATH_MAX_CHARS - 1)}…`;
}

/**
 * The sign-in plate. Split out of `LoginPage` (which is bound to the router via
 * `Route.useSearch`/`useRouteContext`) so every auth state — local-only,
 * SSO-only, both, and methods-unknown — is directly renderable in the colocated
 * RTL tests.
 *
 * The nameplate `<dl>` above the controls situates the visitor in their own
 * estate: it *demonstrates* "runs on your infrastructure" with the host they
 * typed, instead of claiming it in a feature list.
 *
 * @ai-warning must contain exactly one <h1>, and in SSO-only mode exactly one
 * link and zero <button>s — login-layout.test.tsx pins both, and three
 * Playwright specs resolve the SSO control with
 * `getByRole('link', { name: /sign in/i })` under strict mode. That is why the
 * theme toggle lives in the base rail, outside this component.
 */
export function SignInPlate({
  message,
  showLocal,
  showOidc,
  methodsKnown,
  loginHref,
  redirectTo,
  returnTo,
  host,
}: {
  message: string | undefined;
  showLocal: boolean;
  showOidc: boolean;
  methodsKnown: boolean;
  loginHref: string;
  redirectTo: string | undefined;
  /** Already validated by safeRedirectPath; null when there is nothing to show. */
  returnTo: string | null;
  host: string;
}): React.JSX.Element {
  const access = accessMode(showLocal, showOidc, methodsKnown);
  const accessIsCertain = access !== 'unknown' && access !== 'none';

  return (
    <Card
      // 24px / 20px padding, a recorded deviation from the 14px console-tile
      // padding: this is the standalone auth plate, not a bento tile.
      className="w-full max-w-[420px] p-5 sm:p-6"
      style={{ background: 'var(--surface-card)' }}
    >
      <BrandMark className="h-9 w-9" />
      <h1 id="login-title" className="mt-4 font-display text-h1 text-foreground">
        Sign in to Capacity Forecast
      </h1>

      {/* A description list, not a fake instrument row: assistive tech reads
          "Host, lcm.corp.internal — Access, Local accounts", which is the
          intended sentence. No ARIA on top of it. Placed before the form in DOM
          order so heading- and list-navigation reach the plate's facts even
          though autofocus lands in the username field. */}
      <dl className="mt-5 grid grid-cols-[64px_1fr] items-baseline gap-x-3 gap-y-2 border-y border-border py-3.5 sm:grid-cols-[72px_1fr]">
        <dt className="text-label uppercase text-fg-subtle">Host</dt>
        <dd className="font-mono text-numeric tabular-nums text-foreground [overflow-wrap:anywhere]">
          {host}
        </dd>
        <dt className="text-label uppercase text-fg-subtle">Access</dt>
        <dd className={cn('text-body', accessIsCertain ? 'text-foreground' : 'text-fg-muted')}>
          {ACCESS_COPY[access]}
        </dd>
        {returnTo === null ? null : (
          <>
            <dt className="text-label uppercase text-fg-subtle">Return to</dt>
            <dd className="truncate font-mono text-code text-fg-muted">
              {truncateReturnPath(returnTo)}
            </dd>
          </>
        )}
      </dl>

      {showLocal ? (
        <div className="mt-5">
          {/* The form owns the single alert slot in local modes, so a server
              `?error=` and a client-side failure can never stack two banners. */}
          <LocalLoginForm redirectTo={redirectTo} serverMessage={message} />
        </div>
      ) : (
        <AlertSlot message={message} className="mt-5" />
      )}

      {/* Only ever rendered between two controls — local-only and SSO-only both
          render with no orphaned separator. */}
      {showLocal && showOidc ? (
        <div className="my-5 flex items-center gap-3 text-label uppercase text-fg-subtle">
          <span className="h-px flex-1 bg-border" />
          <span>or</span>
          <span className="h-px flex-1 bg-border" />
        </div>
      ) : null}

      {showOidc ? (
        // @ai-warning stays an anchor, never a <button>: it is a plain GET
        // navigation to /api/auth/login, and playwright-oidc/oidc-auth.spec.ts
        // + layout.spec.ts select it by the *link* role. It also never names the
        // identity provider — that is a pre-auth disclosure.
        <Button
          asChild
          size="lg"
          className={cn('w-full', showLocal ? undefined : 'mt-6')}
          variant={showLocal ? 'outline' : 'accent'}
        >
          <a href={loginHref}>Sign in{showLocal ? ' with SSO' : ''}</a>
        </Button>
      ) : null}

      {/* Local accounts have admin-side reset only (no self-serve), so a
          locked-out admin needs a next step rather than a dead end. OIDC
          recovery lives at the IdP, so this is local-mode only. */}
      {showLocal ? (
        <p className="mt-5 border-t border-border pt-4 text-caption text-fg-subtle">
          Locked out? Ask another admin to reset your account.
        </p>
      ) : null}
    </Card>
  );
}

/**
 * The base rail: the product truths that belong on a pre-auth surface, plus the
 * theme toggle.
 *
 * The transport notice keys off `isSecureContext`, not `protocol`, so localhost
 * is correctly treated as secure and the notice never fires in dev. It is
 * rendered in subtle ink with a neutral glyph — deliberately NOT amber or
 * destructive: plain HTTP is a *supported* posture here (HSTS is deliberately
 * off for internal deployments), not an incident. On HTTPS the rail says
 * nothing about transport at all; there is no padlock reassurance, because this
 * page cannot verify a certificate chain from JavaScript.
 *
 * @ai-warning contains no links: the whole page must hold exactly one link
 * matching /sign in/i (the SSO control). The theme toggle is a <button> whose
 * accessible name is "Switch theme (current: …)", and it is last in DOM order
 * so it costs the fast path nothing.
 */
const HERO_POINTS = [
  'Runs on your infrastructure',
  'Every forecast is traceable',
  'Live vSphere sync',
  'Role-based access',
] as const;

/**
 * Brand panel of the split-screen layout. Purely presentational: it carries no
 * control needed to sign in, which is what lets it drop out entirely below
 * `lg` (the sign-in plate is the priority on a phone).
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
        {/* Opaque `bg-card` chip, deliberately NOT the accent-soft `Badge`
            variant: the steel `--accent` label needs to sit on the solid card
            surface, where it clears AA 4.5:1 in both themes — the translucent
            wash over the hero grid would not guarantee that. Copy is a factual
            honesty proof (the PRODUCT.md "reads vCenter, never writes" voice),
            not a marketing tagline. */}
        <span className="inline-flex items-center gap-2 rounded-full border border-accent/30 bg-card px-3 py-1 text-xs font-medium text-accent shadow-[var(--shadow-card)]">
          <ShieldCheck aria-hidden className="h-3.5 w-3.5" />
          Reads vCenter — never writes
        </span>

        {/* A display-styled paragraph rather than a heading: the hero is
            decorative and hidden below `lg`, so an <h1> here would leave the
            page with no h1 at all on a phone. The sign-in plate owns the h1. */}
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

export function BaseRail({ secure }: { secure: boolean }): React.JSX.Element {
  return (
    <footer className="border-t border-border px-6 py-4">
      <div className="mx-auto flex max-w-[880px] flex-wrap items-center justify-center gap-x-5 gap-y-1.5 sm:gap-y-2">
        {/* `lg:hidden` — the hero carries this same claim as a chip at `lg`+,
            and stating it twice on one screen reads as insecurity about it
            rather than emphasis. Below `lg` the hero is gone, so the rail is
            the only place it appears. */}
        <p className="flex items-center gap-1.5 text-caption text-fg-subtle lg:hidden">
          <ShieldCheck aria-hidden className="h-3.5 w-3.5 shrink-0" />
          Reads capacity from vCenter on a schedule — never writes to it.
        </p>
        {secure ? null : (
          <p className="flex items-center gap-1.5 text-caption text-fg-subtle">
            <Unlock aria-hidden className="h-3.5 w-3.5 shrink-0" />
            Not encrypted in transit — this deployment serves plain HTTP.
          </p>
        )}
        <div className="ml-auto">
          <ThemeToggle />
        </div>
      </div>
    </footer>
  );
}

function LoginPage(): React.JSX.Element {
  const { error, redirect: redirectParam } = Route.useSearch();
  const { auth } = Route.useRouteContext();
  const message = loginErrorMessage(error);
  const loginHref = buildLoginHref(redirectParam);
  // Older `/api/auth/me` responses (pre-Task-1) omit `loginMethods` entirely —
  // treat that as the original OIDC-only behaviour so nothing regresses. Do NOT
  // tighten this to `auth.loginMethods?.oidc === true`: that would leave those
  // deployments with no sign-in control at all (#257).
  const showLocal = auth.loginMethods?.local === true;
  const showOidc = auth.loginMethods ? auth.loginMethods.oidc : true;
  // The two ambient facts are read exactly once, here, and prop-drilled: no
  // component below may touch `window.location` (see LocalLoginForm's warning).
  const host = window.location.host;
  const secure = window.isSecureContext;

  return (
    // No `bg-background`: the body already paints the lit --surface-backdrop,
    // and /login was the one surface flattening it.
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      {/* Split screen at `lg`+: the restyled brand hero on the left, the sign-in
          plate on the right. Below `lg` the hero drops out entirely and the
          plate is the whole page — it is the only thing needed to sign in. The
          base rail spans both columns so the theme toggle and the plain-HTTP
          warning stay page-level rather than belonging to one column. */}
      <div className="grid flex-1 grid-cols-1 lg:grid-cols-[1.05fr_1fr]">
        <LoginHero />
        <main
          className="flex items-start justify-center px-4 pb-8 pt-8 sm:items-center sm:px-6 sm:py-12"
          aria-labelledby="login-title"
        >
          <SignInPlate
            message={message}
            showLocal={showLocal}
            showOidc={showOidc}
            methodsKnown={auth.loginMethods !== undefined}
            loginHref={loginHref}
            redirectTo={redirectParam}
            returnTo={safeRedirectPath(redirectParam)}
            host={host}
          />
        </main>
      </div>
      <BaseRail secure={secure} />
    </div>
  );
}
