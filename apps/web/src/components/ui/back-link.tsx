import { Link } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import type * as React from 'react';

import { Kbd } from '@/components/ui/kbd';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * Icon-only back affordance for the cluster panel header (#243): a real link
 * (`<a href="/">` via TanStack `Link`), not a button — it works on deep links
 * and middle-click, and in a two-level hierarchy the arrow IS the degenerate
 * breadcrumb (NN/g: trails add nothing at 1–2 levels). It is the panel's
 * single leave affordance; Esc keeps working through the panel's own handler,
 * which navigates to the same place.
 *
 * The icon is `aria-hidden` and the sr-only text is the whole accessible name
 * ("Back to clusters" — WCAG 2.5.3 needs no visible label to contain). The
 * 32×32 hit area clears WCAG 2.2 SC 2.5.8's 24×24 minimum around the 16px
 * glyph. The Esc hint lives in the tooltip + `aria-keyshortcuts`, replacing
 * the visible keycap the labeled `BackButton` carries — Settings keeps using
 * that component; this one is deliberately separate.
 */
export function BackLink({
  label = 'Back to clusters',
  ref,
}: {
  label?: string;
  ref?: React.Ref<HTMLAnchorElement>;
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          to="/"
          ref={ref}
          aria-keyshortcuts="Escape"
          data-testid="panel-back-link"
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius)] text-fg-muted transition-colors hover:bg-card-hover hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
          <span className="sr-only">{label}</span>
        </Link>
      </TooltipTrigger>
      <TooltipContent className="flex items-center gap-1.5">
        {label}
        <Kbd aria-hidden size="xs">
          Esc
        </Kbd>
      </TooltipContent>
    </Tooltip>
  );
}
