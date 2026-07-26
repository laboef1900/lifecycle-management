import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { loginErrorCodeSchema } from '@lcm/shared';

import { ThemeContext, type ThemeContextValue } from '@/components/theme/use-theme';

import { BaseRail, loginErrorMessage, SignInPlate } from '../login.js';

vi.mock('@/lib/api-client', () => ({
  localLogin: vi.fn(),
}));

const renderPlate = (
  props: Partial<React.ComponentProps<typeof SignInPlate>> = {},
): ReturnType<typeof render> =>
  render(
    <SignInPlate
      message={undefined}
      showLocal
      showOidc
      methodsKnown
      loginHref="/api/auth/login"
      redirectTo={undefined}
      returnTo={null}
      host="lcm.corp.internal"
      {...props}
    />,
  );

const themeValue: ThemeContextValue = {
  theme: 'system',
  resolvedTheme: 'dark',
  setTheme: vi.fn(),
};

const renderRail = (secure: boolean): ReturnType<typeof render> =>
  render(
    <ThemeContext.Provider value={themeValue}>
      <BaseRail secure={secure} />
    </ThemeContext.Provider>,
  );

/**
 * The four auth states the plate must render, as the mode table pins them.
 * `unknown` is the honest-degradation case: `fetchAuthState()` fails closed to
 * `{ authRequired: true }` with no `loginMethods`, which falls back to
 * SSO-only — so the plate must say the access method is unknown rather than
 * imply an SSO button that may already be dead.
 */
const MODES = [
  { name: 'local-only', props: { showLocal: true, showOidc: false, methodsKnown: true } },
  { name: 'SSO-only', props: { showLocal: false, showOidc: true, methodsKnown: true } },
  { name: 'both', props: { showLocal: true, showOidc: true, methodsKnown: true } },
  { name: 'methods-unknown', props: { showLocal: false, showOidc: true, methodsKnown: false } },
] as const;

describe('SignInPlate', () => {
  it('renders the heading and the deployment nameplate', () => {
    renderPlate();
    expect(
      screen.getByRole('heading', { level: 1, name: /sign in to capacity forecast/i }),
    ).toBeInTheDocument();
    // Replaces the removed "Welcome back" eyebrow: the plate's highest-value
    // slot now carries the host the visitor actually typed, which demonstrates
    // "runs on your infrastructure" instead of claiming it.
    expect(screen.getByText('Host')).toBeInTheDocument();
    expect(screen.getByText('lcm.corp.internal')).toBeInTheDocument();
    expect(screen.getByText('Access')).toBeInTheDocument();
  });

  describe('local-only mode', () => {
    it('renders the form with no SSO control and no orphaned divider', () => {
      renderPlate({ showOidc: false });

      expect(screen.getByLabelText(/username/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
      // No SSO link, and the "or" separator must not survive on its own.
      expect(screen.queryByRole('link')).not.toBeInTheDocument();
      expect(screen.queryByText(/^or$/i)).not.toBeInTheDocument();
    });

    it('names the access method as local accounts and offers a recovery route', () => {
      renderPlate({ showOidc: false });
      expect(screen.getByText('Local accounts')).toBeInTheDocument();
      expect(screen.getByText(/locked out\? ask another admin/i)).toBeInTheDocument();
    });
  });

  describe('SSO-only mode', () => {
    it('renders the SSO control as a link and hides the local form', () => {
      renderPlate({ showLocal: false });

      expect(screen.queryByLabelText(/username/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/^or$/i)).not.toBeInTheDocument();
      // Must be a link, not a button: three OIDC e2e specs select it by the
      // link role, and it is a plain GET navigation to /api/auth/login.
      const sso = screen.getByRole('link', { name: /sign in/i });
      expect(sso).toHaveAttribute('href', '/api/auth/login');
      // Zero buttons in the plate — this is why the theme toggle lives in the
      // base rail rather than anywhere inside this component.
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });

    it('names the access method without naming the identity provider', () => {
      renderPlate({ showLocal: false });
      expect(screen.getByText('Identity provider (SSO)')).toBeInTheDocument();
      expect(screen.queryByText(/locked out/i)).not.toBeInTheDocument();
    });

    it('forwards the deep-link redirect on the SSO href', () => {
      renderPlate({ showLocal: false, loginHref: '/api/auth/login?redirect=%2Fclusters' });
      expect(screen.getByRole('link', { name: /sign in/i })).toHaveAttribute(
        'href',
        '/api/auth/login?redirect=%2Fclusters',
      );
    });
  });

  describe('both modes', () => {
    it('renders the form, the divider and an SSO link disambiguated by role', () => {
      renderPlate();

      expect(screen.getByText(/^or$/i)).toBeInTheDocument();
      // The submit button and the SSO link both match /sign in/i — they are
      // disambiguated by role alone, exactly as the e2e suites expect.
      expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /sign in with sso/i })).toBeInTheDocument();
      expect(screen.getByText('Local accounts or SSO')).toBeInTheDocument();
    });
  });

  describe('methods-unknown mode', () => {
    // Honest uncertainty (Product Principle 4): an unreachable /api/auth/me
    // falls back to the SSO control, so the plate must not imply the method is
    // known. The SSO control still renders — tightening that fallback would
    // leave pre-Task-1 deployments with no sign-in control at all (#257).
    it('says the access method is unknown but still offers the SSO fallback', () => {
      renderPlate({ showLocal: false, showOidc: true, methodsKnown: false });
      expect(screen.getByText('Unknown')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /sign in/i })).toBeInTheDocument();
    });
  });

  it('says so when the deployment has no sign-in method configured', () => {
    // Reachable: mode `local` with every local account disabled. "Known to be
    // none" is not the same claim as "unknown", so it gets its own string.
    renderPlate({ showLocal: false, showOidc: false, methodsKnown: true });
    expect(screen.getByText('None configured')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  describe('return-to row', () => {
    it('renders a validated return path', () => {
      renderPlate({ returnTo: '/clusters/ab12' });
      expect(screen.getByText('Return to')).toBeInTheDocument();
      expect(screen.getByText('/clusters/ab12')).toBeInTheDocument();
    });

    it('is hidden entirely when the redirect target was rejected', () => {
      renderPlate({ returnTo: null, redirectTo: '//evil.example.com' });
      expect(screen.queryByText('Return to')).not.toBeInTheDocument();
      expect(screen.queryByText(/evil\.example\.com/)).not.toBeInTheDocument();
    });

    // A same-origin path can still be arbitrarily long attacker-chosen text, so
    // the rendered form is capped rather than allowed to compose a sentence.
    it('caps the rendered path at 40 characters with an ellipsis', () => {
      const long = `/clusters/${'a'.repeat(120)}`;
      renderPlate({ returnTo: long });
      const rendered = screen.getByText(/^\/clusters\/a+…$/);
      expect(rendered.textContent).toHaveLength(40);
    });
  });

  it('renders a server error message as an alert', () => {
    renderPlate({ message: 'Your identity provider rejected the sign-in.' });
    expect(screen.getByRole('alert')).toHaveTextContent(/identity provider rejected the sign-in/i);
  });

  it('renders no alert when there is no error', () => {
    renderPlate();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  // One slot, in every mode: the plate must never stack a server banner on top
  // of the form's own client-side one.
  it.each(MODES)('renders at most one alert in $name mode', ({ props }) => {
    renderPlate({ ...props, message: 'Sign-in didn’t complete. Try again from this page.' });
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });

  /**
   * Migrated from the deleted `LoginHero` block. The hero was removed, but its
   * two structural invariants are properties of the *page*, not of that
   * component — deleting them with it would have been the "delete a test to
   * make it pass" failure. They are re-asserted here across every mode.
   */
  describe('page-level structural invariants (migrated from LoginHero)', () => {
    it.each(MODES)('declares exactly one level-1 heading in $name mode', ({ props }) => {
      const { container } = renderPlate(props);
      render(
        <ThemeContext.Provider value={themeValue}>
          <BaseRail secure />
        </ThemeContext.Provider>,
      );
      expect(within(container).getAllByRole('heading')).toHaveLength(1);
      expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    });

    // Playwright strict mode resolves the SSO control with
    // getByRole('link', { name: /sign in/i }); a second match anywhere on the
    // page would break the entire oidc-e2e job. The base rail and the plate
    // footer are therefore plain text, and the theme toggle is a <button>.
    it.each(MODES)('holds at most one /sign in/i link in $name mode', ({ props }) => {
      renderPlate(props);
      render(
        <ThemeContext.Provider value={themeValue}>
          <BaseRail secure={false} />
        </ThemeContext.Provider>,
      );
      expect(screen.queryAllByRole('link', { name: /sign in/i }).length).toBeLessThanOrEqual(1);
    });
  });
});

describe('BaseRail', () => {
  // The one preserved product truth: live vSphere sync and read-only access,
  // in a single factual clause rather than a feature checklist.
  it('always states that LCM reads vCenter and never writes to it', () => {
    renderRail(true);
    expect(
      screen.getByText(/reads capacity from vcenter on a schedule — never writes to it/i),
    ).toBeInTheDocument();
  });

  it('discloses plain-HTTP transport when the context is not secure', () => {
    renderRail(false);
    expect(
      screen.getByText(/not encrypted in transit — this deployment serves plain http/i),
    ).toBeInTheDocument();
  });

  // No padlock reassurance on the secure path: the page cannot verify a
  // certificate chain from JavaScript, so it says nothing about transport.
  it('says nothing about transport when the context is secure', () => {
    renderRail(true);
    expect(screen.queryByText(/not encrypted in transit/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/encrypted/i)).not.toBeInTheDocument();
  });

  it('carries the theme toggle as a button, never a link', () => {
    renderRail(true);
    expect(screen.getByRole('button', { name: /switch theme/i })).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});

describe('loginErrorMessage', () => {
  it('returns nothing when there is no error param', () => {
    expect(loginErrorMessage(undefined)).toBeUndefined();
    expect(loginErrorMessage('')).toBeUndefined();
  });

  // The Record<LoginErrorCode, string> type guarantees a key exists, not that
  // the copy behind it is the right copy — so pin each string.
  it.each([
    [
      'login_failed',
      'Sign-in couldn’t be completed after returning from the identity provider. Try again from this page.',
    ],
    [
      'state_mismatch',
      'This sign-in attempt expired, or it was started in a different browser or tab. Start again from this page.',
    ],
    [
      'idp_error',
      'Your identity provider rejected the sign-in. The reason was recorded in the server log — ask an administrator to check it.',
    ],
    [
      'access_denied',
      'That account isn’t allowed to use this deployment. Ask an administrator to add it to the sign-in allow-list.',
    ],
    [
      'idp_unavailable',
      'This server can’t reach the identity provider right now. It retries automatically — try again in a moment, and tell an administrator if it persists.',
    ],
    [
      'scheme_mismatch',
      'Sign-in was stopped: this server’s configured base URL uses a different scheme (http or https) than the address you reached it on. An administrator needs to correct it in Settings → Authentication.',
    ],
  ])('maps %s to its own copy', (code, copy) => {
    expect(loginErrorMessage(code)).toBe(copy);
  });

  it('covers every code the server can emit', () => {
    for (const code of loginErrorCodeSchema.options) {
      expect(loginErrorMessage(code)).toBeTypeOf('string');
    }
  });

  // A code this build does not know is its own condition, not a login_failed in
  // disguise — and the raw value is never echoed into the DOM.
  it('gives an unrecognised code its own string and never echoes it', () => {
    const message = loginErrorMessage('<img src=x onerror=alert(1)>');
    expect(message).toBe('Sign-in didn’t complete. Try again from this page.');
    expect(message).not.toContain('img');
  });
});
