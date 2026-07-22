import { useCallback, useSyncExternalStore } from 'react';

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

/**
 * Cluster panel → Hosts tab (`apps/web/src/components/detail/cluster-panel.tsx`).
 *
 * Unlike `ADD_CLUSTER_HASH`, this anchor never appears in the URL: the
 * requester (the unknown-capacity `RecommendationChip`) and the target (the
 * panel's own Tabs) are already mounted together on the same page, so there is
 * no navigation for a location hash to survive. The request counter alone is
 * the whole signal — see `useAnchorFocusRequest`.
 */
export const HOSTS_TAB_HASH = 'hosts-tab';

/**
 * @ai-note (#293, reverses #243 Part B) Settings' three sections used to be
 * `#section-*` in-page table-of-contents anchors on one flat-scrolling
 * `/settings` route — `FORECASTING_SECTION_HASH` / `INVENTORY_SECTION_HASH` /
 * `ACCESS_SECTION_HASH` lived here. They are gone: each section is now its own
 * sub-route (`/settings/forecasting`, `/settings/inventory`,
 * `/settings/access`, see `routes/_app.settings.*.tsx`), so a real router
 * `Link to=` replaces what used to be a fragment anchor — there is no page to
 * scroll within anymore. `ADD_CLUSTER_HASH` above is unaffected: it still
 * deep-links to a specific panel *inside* the Inventory sub-route
 * (`/settings/inventory#add-cluster`) exactly as it deep-linked into the old
 * single page, and still needs `requestAnchorFocus` for the same reason.
 */

/**
 * How many focus requests each anchor has received. Per anchor, and
 * monotonically increasing.
 *
 * @ai-warning Do NOT collapse this into a single "newest request" record. A
 * subscriber's value would then fall to 0 whenever some *other* anchor is
 * requested — and a fall is a dependency *change* like any other, so requesting
 * anchor B would re-run anchor A's effect. Because the request lands
 * synchronously while the router's hash follows a tick later, A would still see
 * its own hash in the URL at that moment and would steal the scroll and focus
 * meant for B. There is only one anchor today; the second one added would hit
 * this. See `anchors.test.tsx`.
 */
const requestCounts = new Map<string, number>();
const listeners = new Set<() => void>();

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
 * `/settings/inventory#add-cluster` did nothing at all). A linking surface
 * MUST call this *in addition to* navigating: the hash keeps the destination
 * shareable and survives a reload, this counter guarantees every invocation is
 * observable even when nothing about the URL changed.
 *
 * A module-level counter is used rather than a nonce in the URL so repeat
 * invocations do not pollute shareable links or the history stack, and rather
 * than the router's internal location `key` so the contract does not depend on
 * TanStack Router's same-URL navigation semantics.
 */
export function requestAnchorFocus(hash: string): void {
  requestCounts.set(hash, (requestCounts.get(hash) ?? 0) + 1);
  for (const listener of listeners) listener();
}

/**
 * Number of focus requests aimed at `hash` — its *value* is meaningless, its
 * *change* is the signal. Use it as an effect dependency alongside the location
 * hash; `add-cluster-panel.tsx` is the reference implementation.
 *
 * Requests aimed at other anchors are invisible here: the snapshot is a plain
 * number, so `useSyncExternalStore`'s `Object.is` check turns them into a true
 * no-op — no re-render, no effect re-run. Counters only ever increase, so a
 * count left over from an earlier interaction (or an earlier test) can never
 * fire an effect on its own, which is why this module needs no reset seam.
 */
export function useAnchorFocusRequest(hash: string): number {
  const getSnapshot = useCallback(() => requestCounts.get(hash) ?? 0, [hash]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
