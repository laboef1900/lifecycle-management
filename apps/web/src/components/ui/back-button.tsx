import { ArrowLeft } from 'lucide-react';
import type * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * Shared "Back" affordance used by the cluster detail panel and the Settings
 * page so the label, left-arrow icon, and decorative Esc hint stay consistent.
 * The `<kbd>` and icon are `aria-hidden`, so the accessible name is exactly the
 * `label` (default "Back"). `ref` forwards to the underlying button — the panel
 * relies on a stable ref for its open-focus / focus-restore management.
 */
export function BackButton({
  onClick,
  label = 'Back',
  className,
  ref,
}: {
  onClick: () => void;
  label?: string;
  className?: string;
  ref?: React.RefObject<HTMLButtonElement | null>;
}): React.JSX.Element {
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      className={cn(
        'flex shrink-0 items-center gap-2 rounded-[var(--radius)] border border-border px-2.5 py-1.5 font-mono text-[10.5px] font-semibold uppercase tracking-[0.1em] text-fg-muted transition-colors hover:border-border-strong hover:text-foreground',
        className,
      )}
    >
      <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
      {label}
      <kbd
        aria-hidden
        className="rounded border border-border px-1 py-0.5 text-[9px] font-semibold text-fg-subtle"
      >
        Esc
      </kbd>
    </button>
  );
}
