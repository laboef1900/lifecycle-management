import { Link } from '@tanstack/react-router';
import { ChevronsLeft, ChevronsRight, LayoutDashboard, Settings } from 'lucide-react';
import { useEffect, useState } from 'react';

import { cn } from '@/lib/utils';

const STORAGE_KEY = 'sidebar';

const navItems = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, exact: true },
  { to: '/settings', label: 'Settings', icon: Settings, exact: false },
] as const;

function readStored(): 'expanded' | 'collapsed' {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === 'collapsed') return 'collapsed';
  } catch {
    // ignore
  }
  return 'expanded';
}

export function Sidebar(): React.JSX.Element {
  const [state, setState] = useState<'expanded' | 'collapsed'>(() => readStored());

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, state);
    } catch {
      // ignore
    }
  }, [state]);

  const collapsed = state === 'collapsed';

  return (
    <aside
      className={cn(
        'flex shrink-0 flex-col border-r border-border bg-card transition-[width] duration-150 ease-out',
        collapsed ? 'w-16' : 'w-60',
      )}
      aria-label="Primary navigation"
    >
      <nav className="flex-1 px-2 py-4">
        <ul className="flex flex-col gap-1">
          {navItems.map((item) => (
            <li key={item.to}>
              <Link
                to={item.to}
                className={cn(
                  'flex items-center gap-3 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground',
                  collapsed && 'justify-center px-0',
                )}
                activeProps={{
                  className: 'bg-muted text-foreground',
                }}
                activeOptions={{ exact: item.exact }}
                title={collapsed ? item.label : undefined}
              >
                <item.icon className="h-5 w-5 shrink-0" aria-hidden />
                {!collapsed && <span>{item.label}</span>}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <div className="border-t border-border p-2">
        <button
          type="button"
          onClick={() => setState(collapsed ? 'expanded' : 'collapsed')}
          className={cn(
            'flex w-full items-center gap-2 rounded-md px-3 py-2 text-xs text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground',
            collapsed && 'justify-center px-0',
          )}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? (
            <ChevronsRight className="h-4 w-4" />
          ) : (
            <>
              <ChevronsLeft className="h-4 w-4" />
              <span>Collapse</span>
            </>
          )}
        </button>
      </div>
    </aside>
  );
}
