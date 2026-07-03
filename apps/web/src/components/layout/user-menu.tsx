import { useRouteContext } from '@tanstack/react-router';
import { LogOut } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export function userInitials(displayName: string | null, email: string | null): string {
  const source = displayName || email || '';
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '?';
  const second = parts.length > 1 ? (parts[1]?.[0] ?? '') : '';
  return (first + second).toUpperCase();
}

export function UserMenu(): React.JSX.Element | null {
  const { auth } = useRouteContext({ from: '__root__' });
  if (!auth.user) return null;
  const { user } = auth;

  const handleSignOut = async (): Promise<void> => {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    } finally {
      // Full-page navigation: stale router context must not outlive the session.
      window.location.assign('/login');
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Account menu"
          className="rounded-full"
        >
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-accent text-xs font-semibold text-accent-foreground">
            {userInitials(user.displayName, user.email)}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>
          <div className="text-sm font-medium">{user.displayName ?? user.email ?? 'Signed in'}</div>
          {user.email ? (
            <div className="text-xs font-normal text-muted-foreground">{user.email}</div>
          ) : null}
          <div className="mt-1 text-[10px] uppercase tracking-wide text-muted-foreground">
            {user.role.toLowerCase()}
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            void handleSignOut();
          }}
        >
          <LogOut className="mr-2 h-4 w-4" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
