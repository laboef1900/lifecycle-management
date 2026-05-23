import { useQuery } from '@tanstack/react-query';
import { Link, Outlet } from '@tanstack/react-router';
import { Activity, Search } from 'lucide-react';

import { CommandPalette } from '@/components/command/command-palette';
import { KeyboardShortcuts } from '@/components/command/keyboard-shortcuts';
import { ShortcutsDialog } from '@/components/command/shortcuts-dialog';
import { Breadcrumbs } from '@/components/layout/breadcrumbs';
import { MobileNavProvider, MobileNavTrigger, useMobileNav } from '@/components/layout/mobile-nav';
import { Sidebar, SidebarNav } from '@/components/layout/sidebar';
import { ThemeToggle } from '@/components/theme/theme-toggle';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { api } from '@/lib/api-client';

export function AppShell(): React.JSX.Element {
  return (
    <MobileNavProvider>
      <div className="flex h-full min-h-screen flex-col bg-background text-foreground">
        <Header />
        <div className="flex min-h-0 flex-1">
          <Sidebar />
          <MobileSidebarSheet />
          <main className="min-w-0 flex-1 overflow-x-hidden">
            <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6">
              <Outlet />
            </div>
          </main>
        </div>
      </div>
      <CommandPalette />
      <ShortcutsDialog />
      <KeyboardShortcuts />
    </MobileNavProvider>
  );
}

function MobileSidebarSheet(): React.JSX.Element {
  const { open, setOpen } = useMobileNav();
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent aria-label="Primary navigation">
        <SidebarNav onNavigate={() => setOpen(false)} />
      </SheetContent>
    </Sheet>
  );
}

function Header(): React.JSX.Element {
  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b border-border bg-card/70 px-4 backdrop-blur-xl sm:gap-4">
      <MobileNavTrigger />
      <Link to="/" className="flex items-center gap-2.5 font-semibold">
        <span
          aria-hidden
          className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-primary to-primary/70 shadow-[var(--shadow-card)]"
        >
          <Activity className="h-4 w-4 text-primary-foreground" />
        </span>
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

  const compact = (label: string, dotClass: string): React.JSX.Element => (
    <span
      role="status"
      aria-label={label}
      title={label}
      className={`inline-flex h-2.5 w-2.5 items-center justify-center rounded-full sm:hidden ${dotClass}`}
    />
  );

  if (healthQuery.status === 'pending') {
    return (
      <>
        {compact('API: checking', 'bg-muted-foreground')}
        <Badge variant="secondary" className="hidden sm:inline-flex">
          API: checking…
        </Badge>
      </>
    );
  }
  if (healthQuery.status === 'error') {
    return (
      <>
        {compact('API: unreachable', 'bg-destructive')}
        <Badge variant="danger" dot className="hidden sm:inline-flex">
          API: unreachable
        </Badge>
      </>
    );
  }
  return (
    <>
      {compact(`API: ${healthQuery.data?.status ?? 'ok'}`, 'bg-success')}
      <Badge variant="success" dot className="hidden sm:inline-flex">
        API: {healthQuery.data?.status}
      </Badge>
    </>
  );
}

function CommandPaletteTrigger(): React.JSX.Element {
  const isMac =
    typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? '');
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label="Open command palette"
        className="sm:hidden"
        onClick={() => window.dispatchEvent(new CustomEvent('lcm:open-command-palette'))}
      >
        <Search className="h-4 w-4" />
      </Button>
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
    </>
  );
}
