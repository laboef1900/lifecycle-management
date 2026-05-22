import { Link, Outlet } from '@tanstack/react-router';
import { Activity } from 'lucide-react';

import { cn } from '@/lib/utils';

const navItems = [
  { to: '/', label: 'Dashboard' },
  { to: '/settings', label: 'Settings' },
] as const;

export function AppShell(): React.JSX.Element {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b bg-card">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-6">
          <Link to="/" className="flex items-center gap-2 font-semibold">
            <Activity className="h-5 w-5 text-primary" />
            <span>Capacity Forecast</span>
          </Link>
          <nav className="flex items-center gap-1 text-sm">
            {navItems.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                className={cn(
                  'rounded-md px-3 py-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
                )}
                activeProps={{
                  className: 'bg-accent text-foreground',
                }}
                activeOptions={{ exact: item.to === '/' }}
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">
        <Outlet />
      </main>
    </div>
  );
}
