import { createFileRoute, redirect } from '@tanstack/react-router';
import { Activity } from 'lucide-react';
import { z } from 'zod';

import { type LoginErrorCode, loginErrorCodeSchema } from '@lcm/shared';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

const loginSearchSchema = z.object({
  error: z.string().optional(),
});

// Keyed by the shared LoginErrorCode union so a new server code fails the build
// here until copy is added, instead of silently degrading to the generic message.
const ERROR_COPY: Record<LoginErrorCode, string> = {
  login_failed: 'Sign-in failed. Please try again.',
  state_mismatch: 'The sign-in attempt expired or was started in another tab. Please try again.',
  idp_error: 'The identity provider reported an error. Please try again.',
  access_denied: 'Your account is not allowed to access this application.',
  idp_unavailable: 'The identity provider is unreachable right now. Please try again shortly.',
  scheme_mismatch:
    'The server is misconfigured (APP_BASE_URL scheme mismatch). Contact your administrator.',
};

export const Route = createFileRoute('/login')({
  validateSearch: loginSearchSchema,
  beforeLoad: ({ context }) => {
    if (!context.auth.authRequired || context.auth.user) {
      throw redirect({ to: '/' });
    }
  },
  component: LoginPage,
});

function LoginPage(): React.JSX.Element {
  const { error } = Route.useSearch();
  const parsedError = loginErrorCodeSchema.safeParse(error);
  const message = parsedError.success
    ? ERROR_COPY[parsedError.data]
    : error
      ? ERROR_COPY.login_failed
      : undefined;
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 text-foreground">
      <Card className="w-full max-w-sm p-8">
        <div className="mb-6 flex items-center gap-2.5 font-semibold">
          <span
            aria-hidden
            className="flex h-7 w-7 items-center justify-center rounded-[var(--radius)] bg-accent"
          >
            <Activity className="h-4 w-4 text-accent-foreground" />
          </span>
          <span>Capacity Forecast</span>
        </div>
        {message ? (
          <p
            role="alert"
            className="mb-4 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {message}
          </p>
        ) : null}
        <p className="mb-6 text-sm text-muted-foreground">
          Sign in with your organization account to continue.
        </p>
        <Button asChild className="w-full">
          <a href="/api/auth/login">Sign in</a>
        </Button>
      </Card>
    </div>
  );
}
