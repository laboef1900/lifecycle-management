import { createFileRoute, redirect } from '@tanstack/react-router';

import { AppShell } from '@/components/layout/app-shell';

export const Route = createFileRoute('/_app')({
  beforeLoad: ({ context }) => {
    if (context.auth.authRequired && !context.auth.user) {
      throw redirect({ to: '/login' });
    }
  },
  component: AppShell,
});
