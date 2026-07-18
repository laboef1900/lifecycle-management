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
