import type { ProcurementInfo } from '@lcm/shared';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { TooltipProvider } from '@/components/ui/tooltip';
import { deriveProcurementKpi } from '@/lib/procurement-kpi';

import { RecommendationChip, deriveRecommendation } from './recommendation-chip';

vi.mock('@/lib/procurement-kpi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/procurement-kpi')>();
  return { ...actual, deriveProcurementKpi: vi.fn(actual.deriveProcurementKpi) };
});

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
    <TooltipProvider>
      <RecommendationChip procurement={procurement()} today={TODAY} {...props} />
    </TooltipProvider>,
  );
}

describe('deriveRecommendation', () => {
  it('derives a crit "order now" with days overdue when the order-by date has passed', () => {
    const rec = deriveRecommendation(procurement({ orderByDate: '2026-07-01' }), TODAY);
    expect(rec.tone).toBe('crit');
    expect(rec.chipLabel).toBe('ORDER NOW');
    expect(rec.shortText).toBe('Order now — 15d overdue');
    expect(rec.message).toBe(
      'Order now — last safe order date 2026-07-01 (15 days overdue) · 6-wk lead',
    );
  });

  it('derives a crit "order now" counting down when the order-by date is within 28 days', () => {
    const rec = deriveRecommendation(procurement({ orderByDate: '2026-07-30' }), TODAY);
    expect(rec.tone).toBe('crit');
    expect(rec.shortText).toBe('Order now — by 2026-07-30');
    expect(rec.message).toBe('Order now — last safe order date 2026-07-30 (in 14 d) · 6-wk lead');
  });

  it('derives planned when the order-by date is comfortably in the future', () => {
    const rec = deriveRecommendation(procurement({ orderByDate: '2026-12-28' }), TODAY);
    expect(rec.tone).toBe('planned');
    expect(rec.chipLabel).toBe('PLANNED');
    expect(rec.shortText).toBe('Order by 2026-12-28');
    expect(rec.message).toMatch(/Order by 2026-12-28 \(in \d+ mo\) · 6-wk lead/);
  });

  it('derives a muted "no order needed" — never omitted — when there is no projected breach', () => {
    const rec = deriveRecommendation(procurement({ orderByDate: null, breachMonth: null }), TODAY);
    expect(rec.tone).toBe('none');
    expect(rec.chipLabel).toBe('OK');
    expect(rec.shortText).toBe('No order needed');
    expect(rec.message).toBe('No order needed in this forecast window.');
  });

  it('derives unknown instead of "no order needed" when capacity is missing', () => {
    const rec = deriveRecommendation(
      procurement({ orderByDate: null, breachMonth: null }),
      TODAY,
      false,
    );
    expect(rec.tone).toBe('unknown');
    expect(rec.chipLabel).toBe('UNKNOWN');
    expect(rec.shortText).toBe('Capacity unknown');
    expect(rec.message).not.toMatch(/no order needed/i);
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
      'Order now — last safe order date 2026-07-01 (15 days overdue) · 6-wk lead',
    );
  });

  it('announces tone changes: the chip content sits inside a role="status" wrapper', () => {
    renderChip();

    const status = screen.getByRole('status');
    expect(status).toBe(screen.getByTestId('recommendation-chip'));
    // role="status" wraps the button rather than replacing its role.
    expect(status).toContainElement(screen.getByRole('button'));
  });

  it('never signals by color alone: every tone carries an icon plus its text label', () => {
    renderChip({ procurement: procurement({ orderByDate: null, breachMonth: null }) });

    const chip = screen.getByTestId('recommendation-chip');
    expect(chip.querySelector('svg')).not.toBeNull();
    expect(chip).toHaveTextContent('OK');
    expect(chip).toHaveTextContent('No order needed');
  });
});
