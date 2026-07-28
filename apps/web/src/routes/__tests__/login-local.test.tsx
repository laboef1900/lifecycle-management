import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { localLogin } from '@/lib/api-client';

import { LocalLoginForm } from '../login.js';

vi.mock('@/lib/api-client', () => ({
  localLogin: vi.fn(),
}));

describe('LocalLoginForm', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders username and password inputs', () => {
    render(<LocalLoginForm redirectTo={undefined} />);
    expect(screen.getByLabelText(/username/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
  });

  // The username field is autofocused so a returning operator lands ready to
  // type; the form is the whole reason the page exists.
  it('puts initial focus in the username field', () => {
    render(<LocalLoginForm redirectTo={undefined} />);
    expect(screen.getByLabelText(/username/i)).toHaveFocus();
  });

  // A server-side ?error= message shares the form's single alert slot, so the
  // page can never stack two red banners.
  it('renders a server message in the same single alert slot', () => {
    render(<LocalLoginForm redirectTo={undefined} serverMessage="Sign-in didn’t complete." />);
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByRole('alert')).toHaveTextContent(/sign-in didn’t complete/i);
  });

  /**
   * `localLogin` resolving a non-`ok` result returns before the component ever
   * touches `useRouter()`'s result, so these paths render safely without a
   * <RouterProvider> ancestor (useRouter() just returns undefined with a
   * console warning outside one).
   *
   * Each result gets its own copy. The old contract was a boolean, which
   * collapsed a 429 from the auth routes' 30/min limiter into "Invalid username
   * or password" — a factual lie — and every other failure into the app's only
   * generic "Something went wrong. Please try again."
   */
  it.each([
    ['invalid', /^Invalid username or password\.$/],
    ['rate_limited', /^Too many sign-in attempts\. Wait a minute, then try again\.$/],
    [
      'error',
      /^The server rejected the sign-in request\. Try again shortly — an administrator can check the server log\.$/,
    ],
  ] as const)('names the %s condition and stops pending', async (result, copy) => {
    vi.mocked(localLogin).mockResolvedValue(result);
    const user = userEvent.setup();

    render(<LocalLoginForm redirectTo={undefined} />);
    await user.type(screen.getByLabelText(/username/i), 'admin');
    await user.type(screen.getByLabelText(/password/i), 'wrong-password');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByText(copy)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign in/i })).not.toBeDisabled();
  });

  // Only a network-level failure rejects (offline/DNS/CORS) — previously the
  // untested branch, and the one that owned the generic error string.
  it('names an unreachable server when localLogin rejects', async () => {
    vi.mocked(localLogin).mockRejectedValue(new TypeError('Failed to fetch'));
    const user = userEvent.setup();

    render(<LocalLoginForm redirectTo={undefined} />);
    await user.type(screen.getByLabelText(/username/i), 'admin');
    await user.type(screen.getByLabelText(/password/i), 'twelvecharsok!');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    expect(
      await screen.findByText(
        /^Couldn’t reach the server\. Check your connection, then try again\.$/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign in/i })).not.toBeDisabled();
  });

  // On success the form does a full-page load (not a client-side navigate) so
  // the app re-bootstraps its startup-fetched auth state with the new session.
  it('full-page-navigates to the redirect target on a successful login', async () => {
    vi.mocked(localLogin).mockResolvedValue('ok');
    const assign = vi.fn();
    vi.stubGlobal('location', { assign, href: 'http://localhost/', origin: 'http://localhost' });
    const user = userEvent.setup();

    render(<LocalLoginForm redirectTo="/clusters" />);
    await user.type(screen.getByLabelText(/username/i), 'admin');
    await user.type(screen.getByLabelText(/password/i), 'twelvecharsok!');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await vi.waitFor(() => expect(assign).toHaveBeenCalledWith('/clusters'));
  });

  it('ignores an off-origin redirect target and lands on /', async () => {
    vi.mocked(localLogin).mockResolvedValue('ok');
    const assign = vi.fn();
    vi.stubGlobal('location', { assign, href: 'http://localhost/', origin: 'http://localhost' });
    const user = userEvent.setup();

    render(<LocalLoginForm redirectTo="//evil.example.com" />);
    await user.type(screen.getByLabelText(/username/i), 'admin');
    await user.type(screen.getByLabelText(/password/i), 'twelvecharsok!');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await vi.waitFor(() => expect(assign).toHaveBeenCalledWith('/'));
  });

  // A naive `startsWith('/') && !startsWith('//')` check passes all of these,
  // but the browser folds a leading backslash to `/` and strips TAB/CR/LF
  // before parsing the authority — each would otherwise navigate off-origin.
  // The shared safeRedirectPath guard must reject them down to '/'.
  it.each([
    ['/\\evil.example.com', 'backslash folded to /'],
    ['/\t/evil.example.com', 'embedded TAB stripped'],
    ['/\r/evil.example.com', 'embedded CR stripped'],
  ])('rejects off-origin bypass vector %j (%s) and lands on /', async (target, _label) => {
    vi.mocked(localLogin).mockResolvedValue('ok');
    const assign = vi.fn();
    vi.stubGlobal('location', { assign, href: 'http://localhost/', origin: 'http://localhost' });
    const user = userEvent.setup();

    render(<LocalLoginForm redirectTo={target} />);
    await user.type(screen.getByLabelText(/username/i), 'admin');
    await user.type(screen.getByLabelText(/password/i), 'twelvecharsok!');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await vi.waitFor(() => expect(assign).toHaveBeenCalledWith('/'));
  });

  // The success path starts a full-page load, so the component stays mounted;
  // the button must stay disabled until the document unloads (no finally-reset
  // that briefly re-enables it and permits a duplicate submit).
  it('keeps the submit button disabled after a successful login', async () => {
    vi.mocked(localLogin).mockResolvedValue('ok');
    const assign = vi.fn();
    vi.stubGlobal('location', { assign, href: 'http://localhost/', origin: 'http://localhost' });
    const user = userEvent.setup();

    render(<LocalLoginForm redirectTo="/clusters" />);
    await user.type(screen.getByLabelText(/username/i), 'admin');
    await user.type(screen.getByLabelText(/password/i), 'twelvecharsok!');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await vi.waitFor(() => expect(assign).toHaveBeenCalled());
    // @ai-warning bare getByRole('button') — it throws on multiple matches, so
    // this form must keep exactly one <button> (a password show/hide toggle is
    // the obvious temptation).
    expect(screen.getByRole('button')).toBeDisabled();
  });
});
