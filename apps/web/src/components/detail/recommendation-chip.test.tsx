import type { ProcurementInfo } from '@lcm/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TooltipProvider } from '@/components/ui/tooltip';
import { HOSTS_TAB_HASH, requestAnchorFocus } from '@/lib/anchors';
import { deriveProcurementKpi } from '@/lib/procurement-kpi';

import { RecommendationChip, deriveRecommendation } from './recommendation-chip';

vi.mock('@/lib/procurement-kpi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/procurement-kpi')>();
  return { ...actual, deriveProcurementKpi: vi.fn(actual.deriveProcurementKpi) };
});

vi.mock('@/lib/anchors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/anchors')>();
  return { ...actual, requestAnchorFocus: vi.fn() };
});

/** Lets a (wrongly) focus-triggered Radix tooltip open land — see back-link.tsx's
 *  identical helper; one macrotask is comfortably enough. */
function flushOpenWindow(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 50));
}

const TODAY = new Date('2026-07-16T00:00:00Z');

function procurement(overrides: Partial<ProcurementInfo> = {}): ProcurementInfo {
  return {
    leadTimeWeeks: 6,
    orderByDate: '2026-12-28',
    breachMonth: '2027-02-01',
    ...overrides,
  };
}

function renderChip(props: Partial<React.ComponentProps<typeof RecommendationChip>> = {}): void {
  render(
    // delayDuration 0 so the hover-open test needs no timer choreography.
    <TooltipProvider delayDuration={0}>
      <RecommendationChip procurement={procurement()} today={TODAY} {...props} />
    </TooltipProvider>,
  );
}

afterEach(() => {
  // `requestAnchorFocus` (mocked above) is a module-level fn shared across
  // every test in this file — clear its call history so one test's click
  // can't leak into the next test's assertions.
  vi.clearAllMocks();
});

describe('deriveRecommendation', () => {
  it('derives a crit "order now" with days overdue when the order-by date has passed', () => {
    const rec = deriveRecommendation(procurement({ orderByDate: '2026-07-01' }), TODAY);
    expect(rec.tone).toBe('crit');
    expect(rec.chipLabel).toBe('ORDER NOW');
    expect(rec.shortText).toBe('Order now — 15d overdue');
    expect(rec.message).toBe(
      'Order now — last safe order date Jul 1 (15 days overdue) · 6-wk lead',
    );
  });

  it('derives a crit "order now" counting down when the order-by date is within 28 days', () => {
    const rec = deriveRecommendation(procurement({ orderByDate: '2026-07-30' }), TODAY);
    expect(rec.tone).toBe('crit');
    expect(rec.shortText).toBe('Order now — by Jul 30');
    expect(rec.message).toBe('Order now — last safe order date Jul 30 (in 14 d) · 6-wk lead');
  });

  it('derives planned when the order-by date is comfortably in the future', () => {
    const rec = deriveRecommendation(procurement({ orderByDate: '2026-12-28' }), TODAY);
    expect(rec.tone).toBe('planned');
    expect(rec.chipLabel).toBe('PLANNED');
    expect(rec.shortText).toBe('Order by Dec 28');
    expect(rec.message).toMatch(/Order by Dec 28 \(in \d+ mo\) · 6-wk lead/);
  });

  it('derives a muted "no order needed" — never omitted — when there is no projected breach', () => {
    const rec = deriveRecommendation(procurement({ orderByDate: null, breachMonth: null }), TODAY);
    expect(rec.tone).toBe('none');
    expect(rec.chipLabel).toBe('OK');
    expect(rec.shortText).toBe('No order needed');
    expect(rec.message).toBe('No order needed in this forecast window.');
  });

  it('derives unknown instead of "no order needed" when capacity is missing, and names the fix location (#243 Part B item 4)', () => {
    const rec = deriveRecommendation(
      procurement({ orderByDate: null, breachMonth: null }),
      TODAY,
      false,
    );
    expect(rec.tone).toBe('unknown');
    expect(rec.chipLabel).toBe('UNKNOWN');
    expect(rec.shortText).toBe('Capacity unknown');
    expect(rec.message).not.toMatch(/no order needed/i);
    // The old copy named the problem but never the fix: name capacity's
    // location (the Hosts tab), not just that it's missing — and use the
    // same "add host capacity to calculate …" phrasing cluster-tile.tsx's
    // verdict/aria-label already ship, so the two surfaces read as one voice.
    expect(rec.message).toBe(
      'Capacity unknown — add host capacity on the Hosts tab to calculate runway.',
    );
  });

  it('derives the urgent tone, not "No order needed", when status is crit/warn but orderByDate is unexpectedly null (MINOR #8)', () => {
    // deriveProcurementKpi never actually returns crit/warn without an
    // orderByDate, but ProcurementKpiStatus's type allows it — this simulates
    // that invariant violation to prove the chip doesn't mask an urgent
    // signal behind a false "all clear".
    vi.mocked(deriveProcurementKpi).mockReturnValueOnce({
      value: '—',
      caption: 'anomalous',
      status: 'crit',
    });
    const rec = deriveRecommendation(
      procurement({ orderByDate: null, breachMonth: '2027-02-01' }),
      TODAY,
    );
    expect(rec.tone).toBe('crit');
    expect(rec.message).toContain('order date unavailable — check forecast');
  });
});

describe('<RecommendationChip>', () => {
  it('renders tone + label + short text on the chip, with the full guidance sr-only (#243)', () => {
    renderChip({ procurement: procurement({ orderByDate: '2026-07-01' }) });

    const chip = screen.getByTestId('recommendation-chip');
    expect(chip.dataset.tone).toBe('crit');
    expect(chip).toHaveTextContent('ORDER NOW');
    expect(chip).toHaveTextContent('Order now — 15d overdue');
    // The full sentence is present for AT without any interaction: it rides
    // sr-only inside the chip, so the accessible name carries everything.
    expect(chip).toHaveTextContent(
      'Order now — last safe order date Jul 1 (15 days overdue) · 6-wk lead',
    );
  });

  it('announces tone changes: the chip content sits inside a role="status" wrapper', () => {
    renderChip();

    const status = screen.getByRole('status');
    expect(status).toBe(screen.getByTestId('recommendation-chip'));
  });

  it('is NOT a tab stop: the tooltip trigger is a non-interactive span (#243 review)', () => {
    renderChip();

    // The chip has no action, so a focusable <button> here was a dead tab
    // stop inside the panel's tab trap that announced itself as operable
    // (WCAG 4.1.2) and read as tappable on touch, where Radix tooltips never
    // open. AT gets the full sentence from the status region's own content.
    const status = screen.getByRole('status');
    expect(within(status).queryByRole('button')).toBeNull();
    const trigger = screen.getByTestId('recommendation-chip-trigger');
    expect(trigger.tagName).toBe('SPAN');
    expect(trigger).not.toHaveAttribute('tabindex');
  });

  it('opens the full-guidance tooltip on hover, portalled OUT of the live region', async () => {
    const user = userEvent.setup();
    renderChip({ procurement: procurement({ orderByDate: '2026-07-01' }) });

    await user.hover(screen.getByTestId('recommendation-chip-trigger'));

    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toHaveTextContent(
      'Order now — last safe order date Jul 1 (15 days overdue) · 6-wk lead',
    );
    // The portal in ui/tooltip.tsx is load-bearing: tooltip content mounted
    // inside this role="status" wrapper would make AT re-announce the full
    // sentence on every hover-in.
    expect(screen.getByRole('status')).not.toContainElement(tooltip);
  });

  it('never signals by color alone: every tone carries an icon plus its text label', () => {
    renderChip({ procurement: procurement({ orderByDate: null, breachMonth: null }) });

    const chip = screen.getByTestId('recommendation-chip');
    expect(chip.querySelector('svg')).not.toBeNull();
    expect(chip).toHaveTextContent('OK');
    expect(chip).toHaveTextContent('No order needed');
  });
});

describe('<RecommendationChip> unknown-capacity fix action (#243 Part B item 4)', () => {
  function renderUnknownChip(capacityKnown = false): void {
    renderChip({
      procurement: procurement({ orderByDate: null, breachMonth: null }),
      capacityKnown,
    });
  }

  it('becomes a real button — unlike every other tone — because it now has an action', () => {
    renderUnknownChip();

    // Unlike the non-interactive-span assertion above (which covers every
    // OTHER tone, all still with nothing to do when clicked), the unknown
    // tone's trigger IS a real, focusable control: it is the only tone with a
    // fix to offer, so the #243 review's "dead tab stop" rationale for the
    // non-interactive span no longer applies to it.
    const trigger = screen.getByTestId('recommendation-chip-trigger');
    expect(trigger.tagName).toBe('BUTTON');
    expect(within(screen.getByRole('status')).getByRole('button')).toBe(trigger);
  });

  it('requests focus on the Hosts tab via the shared anchor mechanism when clicked', async () => {
    const user = userEvent.setup();
    renderUnknownChip();

    await user.click(screen.getByTestId('recommendation-chip-trigger'));

    expect(requestAnchorFocus).toHaveBeenCalledWith(HOSTS_TAB_HASH);
  });

  it('is reachable and operable by keyboard alone — Tab to focus, Enter or Space to activate', async () => {
    // Not pointer-only: a native <button> fires a click on Enter/Space by
    // itself, but this pins that behavior against regression (e.g. a future
    // change wrapping it in a non-button element, or an errant
    // preventDefault on keydown swallowing the browser's default activation).
    const user = userEvent.setup();
    renderUnknownChip();
    const trigger = screen.getByTestId('recommendation-chip-trigger');

    await user.tab();
    expect(trigger).toHaveFocus();

    await user.keyboard('{Enter}');
    expect(requestAnchorFocus).toHaveBeenCalledWith(HOSTS_TAB_HASH);

    vi.mocked(requestAnchorFocus).mockClear();
    await user.keyboard(' ');
    expect(requestAnchorFocus).toHaveBeenCalledWith(HOSTS_TAB_HASH);
  });

  it("keeps the tooltip hover-only — a focus-opened tooltip would swallow the panel's first Esc, same rationale as BackLink", async () => {
    const user = userEvent.setup();
    renderUnknownChip();

    await user.tab();
    expect(screen.getByTestId('recommendation-chip-trigger')).toHaveFocus();
    await flushOpenWindow();
    expect(screen.queryByRole('tooltip')).toBeNull();

    await user.hover(screen.getByTestId('recommendation-chip-trigger'));
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toHaveTextContent(/add host capacity on the hosts tab/i);
  });

  it('leaves every other tone as the non-interactive span with no anchor request', async () => {
    const user = userEvent.setup();
    renderChip({ procurement: procurement({ orderByDate: '2026-07-01' }) }); // crit tone

    const trigger = screen.getByTestId('recommendation-chip-trigger');
    expect(trigger.tagName).toBe('SPAN');
    await user.hover(trigger);
    await screen.findByRole('tooltip');
    expect(requestAnchorFocus).not.toHaveBeenCalled();
  });
});
