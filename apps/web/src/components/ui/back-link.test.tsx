import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { TooltipProvider } from '@/components/ui/tooltip';

import { BackLink } from './back-link';

vi.mock('@tanstack/react-router', () => ({
  // Minimal Link stand-in (same shape as cluster-panel.test.tsx): renders the
  // real anchor semantics the component promises (href, ref, aria attributes)
  // without a router instance.
  Link: ({
    to,
    children,
    ref,
    ...rest
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
    to: string;
    ref?: React.Ref<HTMLAnchorElement>;
  }) => (
    <a href={to} ref={ref} {...rest}>
      {children}
    </a>
  ),
}));

function renderBackLink(): void {
  render(
    // delayDuration 0 so the hover-open path needs no timer choreography.
    <TooltipProvider delayDuration={0}>
      <BackLink />
    </TooltipProvider>,
  );
}

/** Lets a (wrongly) focus-triggered Radix open land — it is synchronous plus
 *  at most a microtask, so one macrotask is comfortably enough. */
function flushOpenWindow(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 50));
}

describe('<BackLink>', () => {
  it('is a real link named for its destination, with the Esc binding machine-readable', () => {
    renderBackLink();

    const link = screen.getByRole('link', { name: 'Back to clusters' });
    expect(link).toHaveAttribute('href', '/');
    expect(link).toHaveAttribute('aria-keyshortcuts', 'Escape');
  });

  it('opens the tooltip on hover — the sighted-pointer path for the label + Esc hint', async () => {
    const user = userEvent.setup();
    renderBackLink();

    await user.hover(screen.getByTestId('panel-back-link'));

    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toHaveTextContent('Back to clusters');
  });

  it('does NOT open the tooltip on keyboard focus (#243: a focus-opened tooltip swallows the first Esc)', async () => {
    // Non-vacuous: Radix 1.2.x's uncontrolled Trigger opens on focus
    // unconditionally (onFocus → onOpen, no :focus-visible gate), so this
    // fails if the controlled hover-only gating is ever removed. The gating
    // matters because a focus-opened tooltip dismisses itself on Escape and
    // marks the event consumed, which the panel's Esc guard respects — the
    // panel's primary keyboard exit would silently cost two presses.
    const user = userEvent.setup();
    renderBackLink();

    await user.tab();
    expect(screen.getByTestId('panel-back-link')).toHaveFocus();
    await flushOpenWindow();
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('does not open on the programmatic focus the panel performs on every open', async () => {
    renderBackLink();

    screen.getByTestId('panel-back-link').focus();
    await flushOpenWindow();
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});
