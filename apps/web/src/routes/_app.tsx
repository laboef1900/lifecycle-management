import { createFileRoute, redirect } from '@tanstack/react-router';

import { AppShell } from '@/components/layout/app-shell';

export const Route = createFileRoute('/_app')({
  beforeLoad: ({ context, location }) => {
    if (context.auth.authRequired && !context.auth.user) {
      // Remember where the user was headed so login can deep-link back there
      // (the server validates the target before honouring it).
      throw redirect({ to: '/login', search: { redirect: location.href } });
    }
  },
  component: AppShell,
});
