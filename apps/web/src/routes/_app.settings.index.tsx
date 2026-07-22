import { createFileRoute, redirect } from '@tanstack/react-router';

// Bare `/settings` (a bookmark, a typed URL, or the ⌘K/topbar/`g s` entry
// points that intentionally still target the section-less path) has no
// section of its own since #293 split Settings into sub-routes — send it to
// the first tab. Mirrors the `/clusters` → `/` precedent in
// `_app.clusters.index.tsx`.
export const Route = createFileRoute('/_app/settings/')({
  beforeLoad: () => {
    throw redirect({ to: '/settings/forecasting' });
  },
});
