import type { ProcurementInfo } from '@lcm/shared';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { deriveProcurementKpi } from '@/lib/procurement-kpi';

import { RecommendationBanner } from './recommendation-banner';

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

describe('RecommendationBanner', () => {
  it('renders a crit-toned "order now" message with days overdue when the order-by date has passed', () => {
    render(
      <RecommendationBanner
        procurement={procurement({ orderByDate: '2026-07-01' })}
        today={TODAY}
      />,
    );

    const banner = screen.getByTestId('recommendation-banner');
    expect(banner).toHaveTextContent(
      'Order now — last safe order date 2026-07-01 (15 days overdue) · 6-wk lead',
    );
    expect(banner.dataset.tone).toBe('crit');
  });

  it('renders a crit-toned "order now" message counting down when the order-by date is within 28 days', () => {
    render(
      <RecommendationBanner
        procurement={procurement({ orderByDate: '2026-07-30' })}
        today={TODAY}
      />,
    );

    const banner = screen.getByTestId('recommendation-banner');
    expect(banner).toHaveTextContent(
      'Order now — last safe order date 2026-07-30 (in 14 d) · 6-wk lead',
    );
    expect(banner.dataset.tone).toBe('crit');
  });

  it('renders a planned message when the order-by date is comfortably in the future', () => {
    render(
      <RecommendationBanner
        procurement={procurement({ orderByDate: '2026-12-28' })}
        today={TODAY}
      />,
    );

    const banner = screen.getByTestId('recommendation-banner');
    expect(banner).toHaveTextContent(/Order by 2026-12-28 \(in \d+ mo\) · 6-wk lead/);
    expect(banner.dataset.tone).toBe('planned');
  });

  it('renders a muted "no order needed" message — and still renders, not omits — when there is no projected breach', () => {
    render(
      <RecommendationBanner
        procurement={procurement({ orderByDate: null, breachMonth: null })}
        today={TODAY}
      />,
    );

    const banner = screen.getByTestId('recommendation-banner');
    expect(banner).toHaveTextContent('No order needed in this forecast window.');
    expect(banner.dataset.tone).toBe('none');
  });

  it('renders the urgent tone, not "No order needed", when status is crit/warn but orderByDate is unexpectedly null (MINOR #8)', () => {
    // deriveProcurementKpi never actually returns crit/warn without an
    // orderByDate, but ProcurementKpiStatus's type allows it — this
    // simulates that invariant violation to prove the banner doesn't mask
    // an urgent signal behind a false "all clear" message.
    vi.mocked(deriveProcurementKpi).mockReturnValueOnce({
      value: '—',
      caption: 'anomalous',
      status: 'crit',
    });

    render(
      <RecommendationBanner
        procurement={procurement({ orderByDate: null, breachMonth: '2027-02-01' })}
        today={TODAY}
      />,
    );

    const banner = screen.getByTestId('recommendation-banner');
    expect(banner).not.toHaveTextContent('No order needed');
    expect(banner).toHaveTextContent('order date unavailable — check forecast');
    expect(banner.dataset.tone).toBe('crit');
  });
});
