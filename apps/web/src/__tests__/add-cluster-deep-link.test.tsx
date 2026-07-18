import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CommandPalette } from '@/components/command/command-palette';
import { AddClusterPanel } from '@/components/settings/add-cluster-panel';
import { ThemeProvider } from '@/components/theme/theme-provider';
import { resetAnchorFocusRequests } from '@/lib/anchors';
import { api } from '@/lib/api-client';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { useIsAdminMock } = vi.hoisted(() => ({ useIsAdminMock: vi.fn(() => true) }));
vi.mock('@/lib/auth', () => ({ useIsAdmin: () => useIsAdminMock() }));

/**
 * A faithful stand-in for TanStack Router's location subscription, because the
 * bug this suite guards lives precisely in the router's same-URL semantics:
 * `navigate()` to the location you are already at produces an identical
 * `location.hash`, so a subscriber's snapshot does not change and no effect
 * keyed on it re-runs. The mock therefore stores the hash and notifies, but
 * hands out the same string — reproducing the no-op rather than papering over
 * it (a mock that re-rendered unconditionally would pass against the bug).
 */
const { routerMock } = vi.hoisted(() => {
  let hash = '';
  const listeners = new Set<() => void>();
  return {
    routerMock: {
      getHash: (): string => hash,
      subscribe: (listener: () => void): (() => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      navigate: (opts: { to: string; hash?: string }): void => {
        hash = opts.hash ?? '';
        for (const listener of listeners) listener();
      },
      // Listeners are not cleared: React unsubscribes on unmount, and dropping
      // them here would race RTL's own cleanup hook.
      reset: (): void => {
        hash = '';
      },
    },
  };
});

vi.mock('@tanstack/react-router', async () => {
  const actual =
    await vi.importActual<typeof import('@tanstack/react-router')>('@tanstack/react-router');
  const { useSyncExternalStore } = await import('react');
  return {
    ...actual,
    useNavigate: () => routerMock.navigate,
    useLocation: <T,>(opts?: {
      select?: (location: { hash: string }) => T;
    }): T | { hash: string } => {
      const hash = useSyncExternalStore(routerMock.subscribe, routerMock.getHash);
      const location = { hash };
      return opts?.select ? opts.select(location) : location;
    },
  };
});

function wrap(node: React.ReactNode): React.ReactElement {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return (
    <ThemeProvider>
      <QueryClientProvider client={qc}>{node}</QueryClientProvider>
    </ThemeProvider>
  );
}

/**
 * Records the elements `scrollIntoView` was called on so assertions can count
 * only the panel's own scrolls — cmdk and Radix scroll their own list items.
 */
function spyOnScrolls(): { panelScrolls: () => number } {
  const targets: Element[] = [];
  vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (this: Element) {
    targets.push(this);
  });
  return { panelScrolls: () => targets.filter((el) => el.id === 'add-cluster').length };
}

describe('⌘K → "Add cluster" deep link (integration: palette + panel)', () => {
  beforeEach(() => {
    vi.spyOn(api.clusters, 'list').mockResolvedValue({
      items: [],
      total: 0,
      limit: 100,
      offset: 0,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useIsAdminMock.mockReset();
    useIsAdminMock.mockReturnValue(true);
    routerMock.reset();
    resetAnchorFocusRequests();
  });

  async function invokeAddClusterAction(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    window.dispatchEvent(new CustomEvent('lcm:open-command-palette'));
    const item = await screen.findByText('Add cluster — Settings');
    await user.click(item);
    await waitFor(() => {
      expect(screen.queryByPlaceholderText(/search/i)).not.toBeInTheDocument();
    });
  }

  function trigger(): HTMLElement {
    return screen.getByRole('button', { name: '+ Add cluster' });
  }

  it('scrolls and focuses the panel on EVERY invocation, including a repeat from /settings#add-cluster', async () => {
    const { panelScrolls } = spyOnScrolls();
    const user = userEvent.setup();
    render(
      wrap(
        <>
          <CommandPalette />
          <AddClusterPanel />
        </>,
      ),
    );

    // First invocation: arrives from a location with no hash.
    await invokeAddClusterAction(user);
    await waitFor(() => expect(trigger()).toHaveFocus());
    expect(panelScrolls()).toBe(1);

    // Leave the panel, exactly as a user reading further down the page would.
    trigger().blur();
    expect(document.body).toHaveFocus();

    // Second invocation, now already at /settings#add-cluster. This is the
    // regression: the navigation is a no-op the panel cannot observe, so a
    // hash-keyed effect never re-runs and focus stays on <body>.
    await invokeAddClusterAction(user);
    await waitFor(() => expect(trigger()).toHaveFocus());
    expect(panelScrolls()).toBe(2);

    // And a third, to prove it is repeatable rather than a one-shot latch.
    trigger().blur();
    await invokeAddClusterAction(user);
    await waitFor(() => expect(trigger()).toHaveFocus());
    expect(panelScrolls()).toBe(3);
  });

  it('leaves the hash on the URL so the deep link stays shareable', async () => {
    spyOnScrolls();
    const user = userEvent.setup();
    render(
      wrap(
        <>
          <CommandPalette />
          <AddClusterPanel />
        </>,
      ),
    );

    await invokeAddClusterAction(user);

    expect(routerMock.getHash()).toBe('add-cluster');
  });

  it('does not focus the panel when an unrelated palette action navigates to settings', async () => {
    const { panelScrolls } = spyOnScrolls();
    const user = userEvent.setup();
    render(
      wrap(
        <>
          <CommandPalette />
          <AddClusterPanel />
        </>,
      ),
    );

    window.dispatchEvent(new CustomEvent('lcm:open-command-palette'));
    await user.click(await screen.findByText('Go to settings'));
    await waitFor(() => {
      expect(screen.queryByPlaceholderText(/search/i)).not.toBeInTheDocument();
    });

    expect(panelScrolls()).toBe(0);
    expect(trigger()).not.toHaveFocus();
  });
});
