import { createFileRoute, redirect } from '@tanstack/react-router';

// The Clusters page merged into the fleet console (spec §2) — `/clusters`
// now redirects to `/`. `/clusters/$id` is untouched (Task 4 turns it into
// the fleet console's detail slide-in panel).
export const Route = createFileRoute('/_app/clusters/')({
  beforeLoad: () => {
    throw redirect({ to: '/' });
  },
});
