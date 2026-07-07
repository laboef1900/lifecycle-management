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

  // `localLogin` resolving `false` returns before the component ever touches
  // `useRouter()`'s result, so this path renders safely without a
  // <RouterProvider> ancestor (useRouter() just returns undefined with a
  // console warning outside one).
  it('shows an error and stops pending when localLogin reports invalid credentials', async () => {
    vi.mocked(localLogin).mockResolvedValue(false);
    const user = userEvent.setup();

    render(<LocalLoginForm redirectTo={undefined} />);
    await user.type(screen.getByLabelText(/username/i), 'admin');
    await user.type(screen.getByLabelText(/password/i), 'wrong-password');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByText(/invalid username or password/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign in/i })).not.toBeDisabled();
  });

  // On success the form does a full-page load (not a client-side navigate) so
  // the app re-bootstraps its startup-fetched auth state with the new session.
  it('full-page-navigates to the redirect target on a successful login', async () => {
    vi.mocked(localLogin).mockResolvedValue(true);
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
    vi.mocked(localLogin).mockResolvedValue(true);
    const assign = vi.fn();
    vi.stubGlobal('location', { assign, href: 'http://localhost/', origin: 'http://localhost' });
    const user = userEvent.setup();

    render(<LocalLoginForm redirectTo="//evil.example.com" />);
    await user.type(screen.getByLabelText(/username/i), 'admin');
    await user.type(screen.getByLabelText(/password/i), 'twelvecharsok!');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await vi.waitFor(() => expect(assign).toHaveBeenCalledWith('/'));
  });
});
