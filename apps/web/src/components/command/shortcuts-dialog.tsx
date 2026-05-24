import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useState } from 'react';

import { Kbd } from '@/components/ui/kbd';

const OPEN_EVENT = 'lcm:open-shortcuts';

interface Row {
  keys: string[];
  label: string;
}

const ROWS: Row[] = [
  { keys: ['⌘', 'K'], label: 'Open command palette' },
  { keys: ['?'], label: 'Show this shortcuts list' },
  { keys: ['Esc'], label: 'Close any modal' },
  { keys: ['g', 'o'], label: 'Go to overview' },
  { keys: ['g', 'c'], label: 'Go to clusters' },
  { keys: ['g', 's'], label: 'Go to settings' },
];

export function ShortcutsDialog(): React.JSX.Element {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const handler = (): void => setOpen(true);
    window.addEventListener(OPEN_EVENT, handler);
    return () => window.removeEventListener(OPEN_EVENT, handler);
  }, []);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-background/70" />
        <Dialog.Content className="fixed left-[50%] top-[50%] z-50 w-[92vw] max-w-md translate-x-[-50%] translate-y-[-50%] rounded-2xl border border-border bg-popover p-5 text-popover-foreground shadow-xl">
          <Dialog.Title className="text-base font-semibold">Keyboard shortcuts</Dialog.Title>
          <Dialog.Description className="mt-1 text-xs text-muted-foreground">
            All shortcuts work when no input is focused.
          </Dialog.Description>
          <ul className="mt-4 space-y-2.5 text-sm">
            {ROWS.map((row) => (
              <li key={row.label} className="flex items-center justify-between gap-4">
                <span>{row.label}</span>
                <span className="flex items-center gap-0.5">
                  {row.keys.map((k, i) => (
                    <Kbd key={`${row.label}-${i}`}>{k}</Kbd>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
