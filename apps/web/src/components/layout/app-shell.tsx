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

/** Skip-link target. Exported so a test can assert link and target agree. */
export const MAIN_CONTENT_ID = 'main-content';

export function AppShell(): React.JSX.Element {
  return (
    <>
      {/* First in the DOM, and outside the shell below, so it is the document's
          first tab stop — before the brand link in the sticky topbar. */}
      <SkipLink />
      <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
        <Header />
        {/* tabIndex={-1} makes the region programmatically focusable without
            adding it to the tab order, which is what lets the skip link land
            focus here; otherwise focus would stay on the link and the next Tab
            would walk straight back into the header it was meant to bypass. */}
        <main
          id={MAIN_CONTENT_ID}
          tabIndex={-1}
          className="relative min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden"
        >
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

/**
 * WCAG 2.2 §2.4.1 "Bypass Blocks" (Level A): a keyboard user must be able to
 * jump the repeated topbar instead of tabbing through it on every page.
 *
 * Hidden off-screen rather than with `sr-only`/`hidden`, so it stays focusable
 * and revealing it is a single `top` swap — no position/display juggling whose
 * cascade order could resolve the wrong way. It is rendered OUTSIDE the shell's
 * `overflow-hidden` flex wrapper and `fixed`: inside, the revealed link would be
 * clipped by that wrapper and painted beneath the `z-30` sticky header. The
 * visible state gets the house two-layer steel ring for free from the global
 * `:focus-visible` rule in styles.css.
 */
function SkipLink(): React.JSX.Element {
  return (
    <a
      href={`#${MAIN_CONTENT_ID}`}
      onClick={(event) => {
        // Move focus here rather than letting the UA follow the fragment: URL
        // hashes are a deep-link contract in this app (see lib/anchors.ts), and
        // a leftover `#main-content` would ride along in shareable locations
        // for no reason. The href stays real so this is a link to assistive
        // tech and keeps working if the handler ever fails to run.
        event.preventDefault();
        document.getElementById(MAIN_CONTENT_ID)?.focus();
      }}
      className="fixed -top-20 left-4 z-50 rounded-[var(--radius)] border border-border-strong bg-card px-3 py-2 text-sm font-medium text-foreground shadow-[var(--shadow-card)] focus:top-3"
    >
      Skip to main content
    </a>
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
  // Points at the default sub-route (#293) rather than bare `/settings`, so
  // the topbar's persistent entry point skips the index route's redirect hop.
  return (
    <>
      <Button asChild type="button" variant="ghost" size="icon" className="sm:hidden">
        <Link to="/settings/forecasting" aria-label="Settings">
          <Settings className="h-4 w-4" />
        </Link>
      </Button>
      <Button asChild type="button" variant="ghost" size="sm" className="hidden sm:inline-flex">
        <Link to="/settings/forecasting">
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
