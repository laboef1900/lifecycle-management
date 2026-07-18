import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useLocation } from '@tanstack/react-router';
import { act, render, screen, waitFor } from '@testing-library/react';
import { useEffect, useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AddClusterPanel } from '@/components/settings/add-cluster-panel';

import { ADD_CLUSTER_HASH, requestAnchorFocus, useAnchorFocusRequest } from './anchors';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ useIsAdmin: () => true }));

/**
 * Reactive stand-in for the router's location subscription. Timing is the whole
 * point of this suite, so the hash and the focus request are driven separately:
 * `requestAnchorFocus` lands synchronously, the router's hash a tick later.
 */
const { locationStore } = vi.hoisted(() => {
  let hash = '';
  const listeners = new Set<() => void>();
  return {
    locationStore: {
      getHash: (): string => hash,
      subscribe: (listener: () => void): (() => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      setHash: (next: string): void => {
        hash = next;
        for (const listener of listeners) listener();
      },
      // Deliberately does not notify: React unsubscribes on unmount, and
      // pushing an update from teardown would race RTL's cleanup hook.
      reset: (): void => {
        hash = '';
      },
    },
  };
});

vi.mock('@tanstack/react-router', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    useLocation: <T,>(opts?: {
      select?: (location: { hash: string }) => T;
    }): T | { hash: string } => {
      const hash = useSyncExternalStore(locationStore.subscribe, locationStore.getHash);
      const location = { hash };
      return opts?.select ? opts.select(location) : location;
    },
  };
});

/**
 * The next anchor. The app ships exactly one today, which is why the defect
 * this suite pins was latent: a shared "newest request" record only misbehaves
 * once a second anchor exists to steal from the first. `vcenter-connections` is
 * the realistic candidate — it is already a panel on the same page.
 */
const VCENTER_HASH = 'vcenter-connections';

/**
 * A second anchor's panel, implementing the `anchors.ts` contract exactly as
 * `AddClusterPanel` does: scroll into view and take focus when either the
 * location hash or this anchor's request count changes.
 */
function VCenterPanel(): React.JSX.Element {
  const hash = useLocation({ select: (location) => location.hash });
  const focusRequests = useAnchorFocusRequest(VCENTER_HASH);
  const cardRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (hash !== VCENTER_HASH) return;
    void focusRequests;
    cardRef.current?.scrollIntoView({ block: 'start' });
    triggerRef.current?.focus({ preventScroll: true });
  }, [hash, focusRequests]);

  return (
    <div ref={cardRef} id={VCENTER_HASH}>
      <button ref={triggerRef} type="button">
        + Add connection
      </button>
    </div>
  );
}

function CountProbe({ hash }: { hash: string }): React.JSX.Element {
  return <span data-testid={`count-${hash}`}>{useAnchorFocusRequest(hash)}</span>;
}

/** Counts `scrollIntoView` calls per anchor element. */
function spyOnScrolls(): (id: string) => number {
  const targets: Element[] = [];
  vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (this: Element) {
    targets.push(this);
  });
  return (id) => targets.filter((element) => element.id === id).length;
}

function renderBothAnchors(): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <AddClusterPanel />
      <VCenterPanel />
    </QueryClientProvider>,
  );
}

const addClusterTrigger = (): HTMLElement => screen.getByRole('button', { name: '+ Add cluster' });
const vcenterTrigger = (): HTMLElement => screen.getByRole('button', { name: '+ Add connection' });

describe('anchor focus requests', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    locationStore.reset();
    // Request counts are deliberately NOT reset: they only ever increase, so a
    // leftover count cannot fire an effect on its own. That is what lets this
    // module ship without a test-only reset export.
  });

  it('never scrolls or focuses one anchor when a different anchor is requested', async () => {
    const scrolls = spyOnScrolls();
    renderBothAnchors();

    // Arrive at #add-cluster the way the ⌘K palette does it: navigate, then request.
    act(() => {
      locationStore.setHash(ADD_CLUSTER_HASH);
      requestAnchorFocus(ADD_CLUSTER_HASH);
    });
    await waitFor(() => expect(addClusterTrigger()).toHaveFocus());
    expect(scrolls(ADD_CLUSTER_HASH)).toBe(1);

    // The user reads on and moves focus off the panel.
    addClusterTrigger().blur();
    expect(document.body).toHaveFocus();

    // Now a *different* anchor is requested. This is the exact window the
    // defect lived in: the request lands synchronously while the router's hash
    // follows a tick later, so the Add-cluster panel re-renders at a moment
    // when #add-cluster is still the hash in the URL. A shared "newest request"
    // record drops this panel's dependency from 1 to 0 here — a change like any
    // other — and it steals the scroll and the focus meant for the other panel.
    act(() => {
      requestAnchorFocus(VCENTER_HASH);
    });

    expect(addClusterTrigger()).not.toHaveFocus();
    expect(document.body).toHaveFocus();
    expect(scrolls(ADD_CLUSTER_HASH)).toBe(1);
    // The requested panel does not jump the gun either — its hash is not current yet.
    expect(vcenterTrigger()).not.toHaveFocus();
    expect(scrolls(VCENTER_HASH)).toBe(0);

    // The hash lands, and the requested anchor — only it — takes over. This
    // also proves the assertions above are not vacuous: the harness can
    // observe a focus move, it just must not observe one on the wrong panel.
    act(() => {
      locationStore.setHash(VCENTER_HASH);
    });
    await waitFor(() => expect(vcenterTrigger()).toHaveFocus());
    expect(scrolls(VCENTER_HASH)).toBe(1);
    expect(scrolls(ADD_CLUSTER_HASH)).toBe(1);
  });

  it('counts requests per anchor, so one anchor cannot reset another', () => {
    render(
      <>
        <CountProbe hash={ADD_CLUSTER_HASH} />
        <CountProbe hash={VCENTER_HASH} />
      </>,
    );
    const read = (hash: string): number =>
      Number(screen.getByTestId(`count-${hash}`).textContent ?? '');

    act(() => {
      requestAnchorFocus(ADD_CLUSTER_HASH);
    });
    // Counts are module state shared with the suite above, so compare against
    // what was actually observed rather than an absolute.
    const addCluster = read(ADD_CLUSTER_HASH);
    expect(addCluster).toBeGreaterThan(0);

    act(() => {
      requestAnchorFocus(VCENTER_HASH);
    });
    expect(read(ADD_CLUSTER_HASH)).toBe(addCluster);
    expect(read(VCENTER_HASH)).toBeGreaterThan(0);

    act(() => {
      requestAnchorFocus(ADD_CLUSTER_HASH);
    });
    expect(read(ADD_CLUSTER_HASH)).toBe(addCluster + 1);
  });
});
