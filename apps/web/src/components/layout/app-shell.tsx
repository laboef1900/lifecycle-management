import { useQuery } from '@tanstack/react-query';
import { Link, Outlet } from '@tanstack/react-router';
import { Activity } from 'lucide-react';

import { Breadcrumbs } from '@/components/layout/breadcrumbs';
import { Sidebar } from '@/components/layout/sidebar';
import { ThemeToggle } from '@/components/theme/theme-toggle';
import { Badge } from '@/components/ui/badge';
import { Kbd } from '@/components/ui/kbd';
import { api } from '@/lib/api-client';

export function AppShell(): React.JSX.Element {
  return (
    <div className="flex h-full min-h-screen flex-col bg-background text-foreground">
      <Header />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="min-w-0 flex-1 overflow-x-hidden">
          <div className="mx-auto w-full max-w-7xl px-6 py-6">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}

function Header(): React.JSX.Element {
  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-4 border-b border-border bg-card/95 px-4 backdrop-blur">
      <Link to="/" className="flex items-center gap-2 font-semibold">
        <Activity className="h-5 w-5 text-primary" aria-hidden />
        <span className="hidden sm:inline">Capacity Forecast</span>
      </Link>
      <div className="hidden h-6 w-px bg-border md:block" aria-hidden />
      <div className="hidden min-w-0 flex-1 md:block">
        <Breadcrumbs />
      </div>
      <div className="ml-auto flex items-center gap-2">
        <ApiHealthPill />
        <CommandPaletteTrigger />
        <ThemeToggle />
      </div>
    </header>
  );
}

function ApiHealthPill(): React.JSX.Element {
  const healthQuery = useQuery({
    queryKey: ['health'],
    queryFn: () => api.health.live(),
    refetchInterval: 30_000,
  });
  if (healthQuery.status === 'pending') {
    return (
      <Badge variant="secondary" className="hidden sm:inline-flex">
        API: checking…
      </Badge>
    );
  }
  if (healthQuery.status === 'error') {
    return (
      <Badge variant="danger" dot className="hidden sm:inline-flex">
        API: unreachable
      </Badge>
    );
  }
  return (
    <Badge variant="success" dot className="hidden sm:inline-flex">
      API: {healthQuery.data?.status}
    </Badge>
  );
}

function CommandPaletteTrigger(): React.JSX.Element {
  // Wired up in Task 8 — the global keyboard handler dispatches a CustomEvent
  // that the palette listens for. For now this is a no-op button that displays
  // the discoverable shortcut.
  const isMac =
    typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? '');
  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new CustomEvent('lcm:open-command-palette'))}
      className="hidden items-center gap-2 rounded-md border border-border bg-muted/40 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground sm:inline-flex"
      aria-label="Open command palette"
    >
      <span>Search</span>
      <span className="flex items-center gap-0.5">
        <Kbd>{isMac ? '⌘' : 'Ctrl'}</Kbd>
        <Kbd>K</Kbd>
      </span>
    </button>
  );
}
