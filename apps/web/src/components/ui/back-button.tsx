import { ArrowLeft } from 'lucide-react';
import type * as React from 'react';

import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';

/**
 * Shared "Back" affordance used by the cluster detail panel and the Settings
 * page so the label, left-arrow icon, and decorative Esc hint stay consistent.
 * Composed from the `chip` Button variant and the `xs` Kbd — the micro-label
 * recipe lives in those primitives, not in a copy of their class strings.
 *
 * The `<kbd>` and icon are `aria-hidden`, so the accessible name is exactly the
 * `label` (default "Back"); `aria-keyshortcuts` is what exposes the Esc binding
 * to assistive tech, since the visual hint is decorative. `ref` forwards to the
 * underlying button — the panel relies on a stable ref for its open-focus /
 * focus-restore management.
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
    <Button
      ref={ref}
      type="button"
      variant="chip"
      size="chip"
      onClick={onClick}
      aria-keyshortcuts="Escape"
      className={className}
    >
      <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
      {label}
      <Kbd aria-hidden size="xs">
        Esc
      </Kbd>
    </Button>
  );
}
