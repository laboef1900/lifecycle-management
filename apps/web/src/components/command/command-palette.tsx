import * as Dialog from '@radix-ui/react-dialog';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Command } from 'cmdk';
import {
  LayoutDashboard,
  Monitor,
  Moon,
  Plus,
  Server,
  Settings,
  Sun,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useState } from 'react';

import { useTheme, type Theme } from '@/components/theme/use-theme';
import { api } from '@/lib/api-client';
import { cn } from '@/lib/utils';

const OPEN_EVENT = 'lcm:open-command-palette';
const CREATE_CLUSTER_EVENT = 'lcm:open-create-cluster';
const SHORTCUTS_EVENT = 'lcm:open-shortcuts';

export function CommandPalette(): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const navigate = useNavigate();
  const { setTheme } = useTheme();

  const clustersQuery = useQuery({
    queryKey: ['clusters'],
    queryFn: () => api.clusters.list(),
    enabled: open,
  });

  useEffect(() => {
    const onOpen = (): void => setOpen(true);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, []);

  const handleOpenChange = (next: boolean): void => {
    setOpen(next);
    if (!next) setSearch('');
  };

  const runAndClose = (fn: () => void): void => {
    fn();
    handleOpenChange(false);
  };

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-background/70 backdrop-blur-sm data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content
          aria-describedby={undefined}
          className={cn(
            'fixed left-[50%] top-[20%] z-50 grid w-[92vw] max-w-[680px] translate-x-[-50%] gap-0',
            'overflow-hidden rounded-2xl border border-border bg-popover text-popover-foreground shadow-xl',
            'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
          )}
        >
          <Dialog.Title className="sr-only">Command palette</Dialog.Title>
          <Command shouldFilter className="flex flex-col" label="Command palette">
            <div className="border-b border-border px-3">
              <Command.Input
                value={search}
                onValueChange={setSearch}
                placeholder="Search clusters, actions, navigation…"
                className="h-12 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>
            <Command.List className="max-h-[60vh] overflow-y-auto py-2">
              <Command.Empty className="px-3 py-6 text-center text-sm text-muted-foreground">
                No matches.
              </Command.Empty>

              <PaletteGroup heading="Navigation">
                <PaletteItem
                  icon={LayoutDashboard}
                  label="Go to dashboard"
                  hint="g d"
                  onSelect={() => runAndClose(() => navigate({ to: '/' }))}
                />
                <PaletteItem
                  icon={Settings}
                  label="Go to settings"
                  hint="g s"
                  onSelect={() => runAndClose(() => navigate({ to: '/settings' }))}
                />
              </PaletteGroup>

              {clustersQuery.data && clustersQuery.data.length > 0 ? (
                <PaletteGroup heading="Clusters">
                  {clustersQuery.data.map((cluster) => (
                    <PaletteItem
                      key={cluster.id}
                      icon={Server}
                      label={cluster.name}
                      onSelect={() =>
                        runAndClose(() =>
                          navigate({ to: '/clusters/$id', params: { id: cluster.id } }),
                        )
                      }
                    />
                  ))}
                </PaletteGroup>
              ) : null}

              <PaletteGroup heading="Actions">
                <PaletteItem
                  icon={Plus}
                  label="Create cluster"
                  onSelect={() =>
                    runAndClose(() => window.dispatchEvent(new CustomEvent(CREATE_CLUSTER_EVENT)))
                  }
                />
                <PaletteItem
                  icon={Settings}
                  label="View keyboard shortcuts"
                  hint="?"
                  onSelect={() =>
                    runAndClose(() => window.dispatchEvent(new CustomEvent(SHORTCUTS_EVENT)))
                  }
                />
              </PaletteGroup>

              <PaletteGroup heading="Theme">
                <PaletteItem
                  icon={Monitor}
                  label="Use system theme"
                  onSelect={() => runAndClose(() => setTheme('system' as Theme))}
                />
                <PaletteItem
                  icon={Sun}
                  label="Use light theme"
                  onSelect={() => runAndClose(() => setTheme('light' as Theme))}
                />
                <PaletteItem
                  icon={Moon}
                  label="Use dark theme"
                  onSelect={() => runAndClose(() => setTheme('dark' as Theme))}
                />
              </PaletteGroup>
            </Command.List>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

interface PaletteGroupProps {
  heading: string;
  children: React.ReactNode;
}

function PaletteGroup({ heading, children }: PaletteGroupProps): React.JSX.Element {
  return (
    <Command.Group
      heading={heading}
      className="px-2 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-muted-foreground"
    >
      {children}
    </Command.Group>
  );
}

interface PaletteItemProps {
  icon: LucideIcon;
  label: string;
  hint?: string;
  onSelect: () => void;
}

function PaletteItem({ icon: Icon, label, hint, onSelect }: PaletteItemProps): React.JSX.Element {
  return (
    <Command.Item
      value={label}
      onSelect={onSelect}
      className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-foreground aria-selected:bg-accent aria-selected:text-accent-foreground"
    >
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="flex-1">{label}</span>
      {hint ? <span className="font-mono text-[10px] text-muted-foreground">{hint}</span> : null}
    </Command.Item>
  );
}
