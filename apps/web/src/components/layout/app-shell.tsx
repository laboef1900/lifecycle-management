import { Link, Outlet } from '@tanstack/react-router';
import { Activity, Search } from 'lucide-react';

import { CommandPalette } from '@/components/command/command-palette';
import { KeyboardShortcuts } from '@/components/command/keyboard-shortcuts';
import { ShortcutsDialog } from '@/components/command/shortcuts-dialog';
import { Breadcrumbs } from '@/components/layout/breadcrumbs';
import { MobileNavProvider, MobileNavTrigger, useMobileNav } from '@/components/layout/mobile-nav';
import { Sidebar, SidebarNav } from '@/components/layout/sidebar';
import { ThemeToggle } from '@/components/theme/theme-toggle';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';

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
      <SheetContent>
        <SheetTitle className="sr-only">Primary navigation</SheetTitle>
        <SidebarNav onNavigate={() => setOpen(false)} />
      </SheetContent>
    </Sheet>
  );
}

function Header(): React.JSX.Element {
  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b border-border bg-background px-4 sm:gap-4">
      <MobileNavTrigger />
      <Link to="/" className="flex items-center gap-2.5 font-semibold">
        <span
          aria-hidden
          className="flex h-7 w-7 items-center justify-center rounded-[var(--radius)] bg-accent"
        >
          <Activity className="h-4 w-4 text-accent-foreground" />
        </span>
        <span className="hidden sm:inline">Capacity Forecast</span>
      </Link>
      <div className="hidden h-6 w-px bg-border md:block" aria-hidden />
      <div className="hidden min-w-0 flex-1 md:block">
        <Breadcrumbs />
      </div>
      <div className="ml-auto flex items-center gap-2">
        <CommandPaletteTrigger />
        <ThemeToggle />
      </div>
    </header>
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
