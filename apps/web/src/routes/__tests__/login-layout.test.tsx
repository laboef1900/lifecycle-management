import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { LoginHero, SignInCard } from '../login.js';

vi.mock('@/lib/api-client', () => ({
  localLogin: vi.fn(),
}));

const renderCard = (
  props: Partial<React.ComponentProps<typeof SignInCard>> = {},
): ReturnType<typeof render> =>
  render(
    <SignInCard
      message={undefined}
      showLocal
      showOidc
      loginHref="/api/auth/login"
      redirectTo={undefined}
      {...props}
    />,
  );

describe('SignInCard', () => {
  it('renders the heading, eyebrow and brand mark', () => {
    renderCard();
    expect(
      screen.getByRole('heading', { level: 1, name: /sign in to capacity forecast/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/welcome back/i)).toBeInTheDocument();
  });

  describe('local-only mode', () => {
    it('renders the form with no SSO control and no orphaned divider', () => {
      renderCard({ showOidc: false });

      expect(screen.getByLabelText(/username/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
      // No SSO link, and the "or" separator must not survive on its own.
      expect(screen.queryByRole('link')).not.toBeInTheDocument();
      expect(screen.queryByText(/^or$/i)).not.toBeInTheDocument();
    });
  });

  describe('SSO-only mode', () => {
    it('renders the SSO control as a link and hides the local form', () => {
      renderCard({ showLocal: false });

      expect(screen.queryByLabelText(/username/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/^or$/i)).not.toBeInTheDocument();
      // Must be a link, not a button: three OIDC e2e specs select it by the
      // link role, and it is a plain GET navigation to /api/auth/login.
      const sso = screen.getByRole('link', { name: /sign in/i });
      expect(sso).toHaveAttribute('href', '/api/auth/login');
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });

    it('forwards the deep-link redirect on the SSO href', () => {
      renderCard({ showLocal: false, loginHref: '/api/auth/login?redirect=%2Fclusters' });
      expect(screen.getByRole('link', { name: /sign in/i })).toHaveAttribute(
        'href',
        '/api/auth/login?redirect=%2Fclusters',
      );
    });
  });

  describe('both modes', () => {
    it('renders the form, the divider and an SSO link disambiguated by role', () => {
      renderCard();

      expect(screen.getByText(/^or$/i)).toBeInTheDocument();
      // The submit button and the SSO link both match /sign in/i — they are
      // disambiguated by role alone, exactly as the e2e suites expect.
      expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /sign in with sso/i })).toBeInTheDocument();
    });
  });

  it('renders a server error message as an alert', () => {
    renderCard({ message: 'The identity provider reported an error. Please try again.' });
    expect(screen.getByRole('alert')).toHaveTextContent(/identity provider reported an error/i);
  });

  it('renders no alert when there is no error', () => {
    renderCard();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('LoginHero', () => {
  it('renders the approved brand copy and the 2x2 checklist', () => {
    render(<LoginHero />);

    expect(screen.getByText(/reads vcenter — never writes/i)).toBeInTheDocument();
    expect(screen.getByText(/capacity you can see coming\./i)).toBeInTheDocument();
    expect(
      screen.getByText(/one source of truth for every purchasing decision/i),
    ).toBeInTheDocument();

    const items = within(screen.getByRole('list')).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual([
      'Runs on your infrastructure',
      'Every forecast is traceable',
      'Live vSphere sync',
      'Role-based access',
    ]);
  });

  // Playwright strict mode resolves the SSO control with
  // getByRole('link', { name: /sign in/i }); a hero link matching that name
  // would break the entire oidc-e2e job.
  it('contains no links at all, so it cannot collide with the SSO selector', () => {
    render(<LoginHero />);
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });

  // The hero is decorative and hidden below `lg`; the sign-in card owns the h1
  // so a phone-width render is not left with a heading-less page.
  it('declares no heading', () => {
    render(<LoginHero />);
    expect(screen.queryAllByRole('heading')).toHaveLength(0);
  });
});
