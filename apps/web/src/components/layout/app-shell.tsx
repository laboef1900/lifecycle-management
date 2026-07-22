import { Link, Outlet } from '@tanstack/react-router';
import { Search, Settings } from 'lucide-react';

import { CommandPalette } from '@/components/command/command-palette';
import { KeyboardShortcuts } from '@/components/command/keyboard-shortcuts';
import { ShortcutsDialog } from '@/components/command/shortcuts-dialog';
import { UserMenu } from '@/components/layout/user-menu';
import { ThemeToggle } from '@/components/theme/theme-toggle';
import { BrandMark } from '@/components/ui/brand-mark';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';

export function AppShell(): React.JSX.Element {
  return (
    <>
      <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
        <Header />
        <main className="relative min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden">
          <div className="mx-auto w-full max-w-screen-2xl px-4 py-6 sm:px-6">
            <Outlet />
          </div>
        </main>
      </div>
      <CommandPalette />
      <ShortcutsDialog />
      <KeyboardShortcuts />
    </>
  );
}

function Header(): React.JSX.Element {
  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b border-border bg-background px-4 sm:gap-4">
      <Link to="/" className="flex items-center gap-2.5 font-display font-semibold">
        <BrandMark className="h-7 w-7" />
        <span>Capacity Forecast</span>
      </Link>
      <div className="ml-auto flex items-center gap-2">
        <CommandPaletteTrigger />
        <nav aria-label="Primary navigation">
          <SettingsLink />
        </nav>
        <ThemeToggle />
        <UserMenu />
      </div>
    </header>
  );
}

function SettingsLink(): React.JSX.Element {
  return (
    <>
      <Button asChild type="button" variant="ghost" size="icon" className="sm:hidden">
        <Link to="/settings" aria-label="Settings">
          <Settings className="h-4 w-4" />
        </Link>
      </Button>
      <Button asChild type="button" variant="ghost" size="sm" className="hidden sm:inline-flex">
        <Link to="/settings">
          <Settings className="h-4 w-4" />
          <span>Settings</span>
        </Link>
      </Button>
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
