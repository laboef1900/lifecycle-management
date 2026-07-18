import { useSyncExternalStore } from 'react';

/**
 * URL hashes that deep-link to a specific panel within a page.
 *
 * @ai-note These are a contract between the *linking* surface (the ⌘K palette,
 * the fleet empty-state CTA) and the *target* panel, which scrolls itself into
 * view and moves focus on arrival. Renaming one without the other silently
 * degrades the link to a plain page navigation — keep them in this one place.
 */

/** Settings → Add cluster panel (`apps/web/src/components/settings/add-cluster-panel.tsx`). */
export const ADD_CLUSTER_HASH = 'add-cluster';

interface AnchorFocusRequest {
  readonly hash: string;
  readonly count: number;
}

const NO_REQUEST: AnchorFocusRequest = { hash: '', count: 0 };

let request: AnchorFocusRequest = NO_REQUEST;
const listeners = new Set<() => void>();

/** Snapshot identity is stable between requests, as `useSyncExternalStore` requires. */
function getRequest(): AnchorFocusRequest {
  return request;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Ask the panel owning `hash` to scroll itself into view and take focus.
 *
 * @ai-warning The URL hash alone is NOT enough to drive the panel. Re-invoking
 * a deep link while the URL already carries its hash produces an identical
 * location, so an effect keyed on the hash never re-runs and the action is a
 * silent no-op (⌘K → "Add cluster" a second time while already sitting on
 * `/settings#add-cluster` did nothing at all). A linking surface MUST call this
 * *in addition to* navigating: the hash keeps the destination shareable and
 * survives a reload, this counter guarantees every invocation is observable
 * even when nothing about the URL changed.
 *
 * A module-level counter is used rather than a nonce in the URL so repeat
 * invocations do not pollute shareable links or the history stack, and rather
 * than the router's internal location `key` so the contract does not depend on
 * TanStack Router's same-URL navigation semantics.
 */
export function requestAnchorFocus(hash: string): void {
  request = { hash, count: request.count + 1 };
  for (const listener of listeners) listener();
}

/**
 * Number of focus requests aimed at `hash` — changes on every invocation, and
 * is `0` while the latest request targets some other anchor. Use it as an
 * effect dependency alongside the location hash.
 */
export function useAnchorFocusRequest(hash: string): number {
  const current = useSyncExternalStore(subscribe, getRequest, getRequest);
  return current.hash === hash ? current.count : 0;
}

/** Test-only: drop the pending request so suites do not leak into each other. */
export function resetAnchorFocusRequests(): void {
  request = NO_REQUEST;
  for (const listener of listeners) listener();
}
