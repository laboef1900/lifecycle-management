import { createFileRoute, redirect } from '@tanstack/react-router';

/**
 * @ai-note (#297 review fix) Maps a pre-#293 bookmark's fragment onto its
 * replacement. `#section-forecasting` / `#section-inventory` /
 * `#section-access` (`FORECASTING_SECTION_HASH` / `INVENTORY_SECTION_HASH` /
 * `ACCESS_SECTION_HASH`, retired in `lib/anchors.ts`) named a *section* of the
 * old flat-scroll `/settings` page — each section is now its own route, so
 * the fragment maps straight onto that route and there is no hash left to
 * carry (nothing on the destination scrolls to a `#section-*` id anymore).
 * `#add-cluster` (`ADD_CLUSTER_HASH`, still live) is different: it addresses a
 * real panel *within* the Inventory sub-route, so it MUST survive onto the
 * new URL — dropping it would silently degrade the ⌘K/fleet-empty-state deep
 * link's pre-#293 spelling to a bare page load. Entries deliberately omit the
 * `hash` key rather than setting it to `undefined`, so passing them straight
 * to `redirect()` satisfies `exactOptionalPropertyTypes`.
 */
const LEGACY_HASH_TARGETS: Record<
  string,
  { to: '/settings/forecasting' | '/settings/inventory' | '/settings/access'; hash?: string }
> = {
  'section-forecasting': { to: '/settings/forecasting' },
  'section-inventory': { to: '/settings/inventory' },
  'section-access': { to: '/settings/access' },
  'add-cluster': { to: '/settings/inventory', hash: 'add-cluster' },
};

// Bare `/settings` (a bookmark, a typed URL, or the ⌘K/topbar/`g s` entry
// points that intentionally still target the section-less path) has no
// section of its own since #293 split Settings into sub-routes — send it to
// the first tab, unless the incoming hash is a pre-#293 bookmark we can map
// onto its replacement (see `LEGACY_HASH_TARGETS` above). Mirrors the
// `/clusters` → `/` precedent in `_app.clusters.index.tsx`.
export const Route = createFileRoute('/_app/settings/')({
  beforeLoad: ({ location }) => {
    const target = LEGACY_HASH_TARGETS[location.hash] ?? { to: '/settings/forecasting' };
    throw redirect(target);
  },
});
