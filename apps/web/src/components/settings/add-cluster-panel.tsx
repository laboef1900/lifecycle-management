import { useLocation } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';

import { AdminOnly } from '@/components/auth/admin-only';
import { CreateClusterDialog } from '@/components/clusters/create-cluster-dialog';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ADD_CLUSTER_HASH } from '@/lib/anchors';
import { useMediaQuery } from '@/lib/use-media-query';

/**
 * Settings panel hosting the manual "Add cluster" action (#223). Adding a
 * cluster by hand is a configuration task, not a day-to-day monitoring action,
 * so it lives with the other Settings panels rather than on the fleet console.
 *
 * Admin-only: the whole section is hidden from viewers (the server 403s the
 * mutation regardless — this is the matching UX affordance).
 */
export function AddClusterPanel(): React.JSX.Element {
  return (
    <AdminOnly>
      <AddClusterCard />
    </AdminOnly>
  );
}

/**
 * Split out so the deep-link hooks below only run when the panel actually
 * renders — viewers never mount this, so there is nothing to scroll to.
 */
function AddClusterCard(): React.JSX.Element {
  const hash = useLocation({ select: (location) => location.hash });
  const cardRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const prefersReducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');

  // Deep link from the ⌘K palette and the fleet empty-state CTA (#223 review
  // follow-up): this panel is the fourth on the page, so arriving at the top of
  // /settings left both the viewport and focus nowhere near the promised
  // control. Move both to it.
  //
  // @ai-note Keyed on `hash`, not a bare mount effect, so the deep link still
  // works when the user is already on /settings — TanStack Router navigates via
  // pushState, which fires no `hashchange` event.
  useEffect(() => {
    if (hash !== ADD_CLUSTER_HASH) return;
    cardRef.current?.scrollIntoView({
      behavior: prefersReducedMotion ? 'auto' : 'smooth',
      block: 'start',
    });
    // `preventScroll` so focusing doesn't jump-cut past the smooth scroll above.
    triggerRef.current?.focus({ preventScroll: true });
  }, [hash, prefersReducedMotion]);

  return (
    <Card ref={cardRef} id={ADD_CLUSTER_HASH} className="scroll-mt-24 p-6">
      <header className="mb-4">
        <h2 className="font-display text-lg">Add cluster</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Manually track a vSphere cluster that isn&rsquo;t synced from a vCenter connection. You
          provide the memory baseline; the forecast builds from there.
        </p>
      </header>
      <CreateClusterDialog
        trigger={
          <Button ref={triggerRef} variant="accent">
            + Add cluster
          </Button>
        }
      />
    </Card>
  );
}
