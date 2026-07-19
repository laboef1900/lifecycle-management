import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  OrderByRail,
  formatRelativeDays,
  orderByUrgency,
  type OrderByRailItem,
} from './order-by-rail';

describe('orderByUrgency', () => {
  const today = new Date('2026-07-16');

  it('is "now" when the order-by date is within 28 days', () => {
    expect(orderByUrgency('2026-08-01', today)).toBe('now'); // 16 days out
  });

  it('is "now" when the order-by date is already past', () => {
    expect(orderByUrgency('2026-06-01', today)).toBe('now');
  });

  it('is "soon" when the order-by date is between 29 and 90 days out', () => {
    expect(orderByUrgency('2026-09-14', today)).toBe('soon'); // 60 days out
  });

  it('is "planned" when the order-by date is more than 90 days out', () => {
    expect(orderByUrgency('2026-12-28', today)).toBe('planned');
  });

  it('is "none" when there is no order-by date', () => {
    expect(orderByUrgency(null, today)).toBe('none');
  });
});

describe('formatRelativeDays', () => {
  const today = new Date('2026-07-16');

  it('formats overdue dates', () => {
    expect(formatRelativeDays('2026-07-10', today)).toMatch(/overdue/);
  });

  it('formats near dates in days', () => {
    expect(formatRelativeDays('2026-07-21', today)).toBe('in 5 d');
  });

  it('formats mid-range dates in weeks', () => {
    expect(formatRelativeDays('2026-10-14', today)).toMatch(/wk/);
  });

  it('formats far dates in months', () => {
    expect(formatRelativeDays('2026-12-28', today)).toMatch(/mo/);
  });
});

const items: OrderByRailItem[] = [
  {
    clusterId: 'c-oracle',
    name: 'CL-Prod-P2-Oracle',
    orderByDate: '2026-09-14',
    leadTimeWeeks: 13,
  },
  { clusterId: 'c-p1', name: 'CL-Prod-P1', orderByDate: '2026-12-28', leadTimeWeeks: 13 },
];

describe('<OrderByRail>', () => {
  it('renders one tick per item', () => {
    render(<OrderByRail items={items} />);
    expect(screen.getAllByRole('button')).toHaveLength(2);
  });

  it('gives each tick an aria-label containing the cluster name, the date, and relative days', () => {
    render(<OrderByRail items={items} />);
    const button = screen.getByRole('button', { name: /CL-Prod-P2-Oracle/ });
    expect(button.getAttribute('aria-label')).toContain('2026-09-14');
    expect(button.getAttribute('aria-label')).toMatch(/in \d+|overdue/i);
  });

  it('gives every tick a >=24px hit-area class', () => {
    render(<OrderByRail items={items} />);
    for (const button of screen.getAllByRole('button')) {
      expect(button.className).toMatch(/min-h-6/);
      expect(button.className).toMatch(/min-w-6/);
    }
  });

  it('renders an empty state with no ticks when there are no items', () => {
    render(<OrderByRail items={[]} />);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.getByText(/no order-by dates in the next 12 months/i)).toBeInTheDocument();
  });

  it('renames the heading to the user-facing "Order deadlines" mental model (finding: rail jargon)', () => {
    render(<OrderByRail items={[]} />);
    expect(screen.getByRole('heading', { level: 2, name: /order deadlines/i })).toBeInTheDocument();
    // The old spec-jargon heading text is gone entirely, not just supplemented.
    expect(screen.queryByText(/order-by rail/i)).toBeNull();
  });

  it('keeps the same renamed heading when populated', () => {
    render(<OrderByRail items={items} />);
    expect(screen.getByRole('heading', { level: 2, name: /order deadlines/i })).toBeInTheDocument();
  });

  // Finding: the empty rail spent ~170px restating the verdict below it via a
  // fixed 86px tick area plus a 12-month axis that encodes nothing at zero
  // ticks. The empty state must collapse to a compact strip instead.
  describe('<OrderByRail> empty-state compaction', () => {
    it('hides the fixed-height tick area and the month axis when there are no ticks', () => {
      const { container } = render(<OrderByRail items={[]} />);
      expect(container.querySelector('.h-\\[86px\\]')).not.toBeInTheDocument();
      // The month axis renders one abbreviated label per month (12 total)
      // when populated; none should render when the rail is empty. Keyed off
      // a testid rather than the `translate-x-1` styling utility, which a
      // restyle would silently turn into a zero-match on BOTH branches —
      // passing this assertion for the wrong reason.
      expect(screen.queryAllByTestId('rail-month-label')).toHaveLength(0);
    });

    it('shows the full tick area and month axis once there is at least one tick', () => {
      const { container } = render(<OrderByRail items={items} />);
      expect(container.querySelector('.h-\\[86px\\]')).toBeInTheDocument();
      expect(screen.getAllByTestId('rail-month-label')).toHaveLength(12);
    });

    it('renders the heading and the checkmark sentence within the same inline row, not stacked blocks', () => {
      render(<OrderByRail items={[]} />);
      const heading = screen.getByRole('heading', { level: 2, name: /order deadlines/i });
      const sentence = screen.getByText(/no order-by dates in the next 12 months/i);
      // The old layout stacked a header row above a separately-centered 86px
      // box; the fix puts both texts in one row so the heading's own parent
      // contains the sentence too.
      expect(heading.parentElement).toContainElement(sentence);
    });
  });

  describe('<OrderByRail> empty-state hint copy (finding: hint describes invisible chrome)', () => {
    it('describes what a tick will mean, instead of the old lead-time-zone copy', () => {
      render(<OrderByRail items={[]} />);
      expect(screen.getByText(/each mark = a cluster's last safe order date/i)).toBeInTheDocument();
      expect(screen.queryByText(/the lead-time zone appears/i)).toBeNull();
    });

    it('keeps the #218-mandated populated hint unchanged', () => {
      render(<OrderByRail items={items} />);
      expect(screen.getByText(/shaded = inside 91-day lead time/i)).toBeInTheDocument();
      expect(screen.queryByText(/each mark = a cluster's last safe order date/i)).toBeNull();
    });
  });

  it('calls onTickHover with the cluster id on hover and null on leave', () => {
    const onTickHover = vi.fn();
    render(<OrderByRail items={items} onTickHover={onTickHover} />);
    const button = screen.getByRole('button', { name: /CL-Prod-P1/ });
    fireEvent.mouseEnter(button);
    expect(onTickHover).toHaveBeenCalledWith('c-p1');
    fireEvent.mouseLeave(button);
    expect(onTickHover).toHaveBeenCalledWith(null);
  });

  it('marks the tick matching linkedId with a linked data attribute', () => {
    render(<OrderByRail items={items} linkedId="c-oracle" />);
    const linked = screen.getByRole('button', { name: /CL-Prod-P2-Oracle/ });
    const other = screen.getByRole('button', { name: /CL-Prod-P1/ });
    expect(linked).toHaveAttribute('data-linked', 'true');
    expect(other).not.toHaveAttribute('data-linked', 'true');
  });

  it('tags each tick with data-cluster-id for rail<->tile linking', () => {
    render(<OrderByRail items={items} />);
    const button = screen.getByRole('button', { name: /CL-Prod-P1/ });
    expect(button).toHaveAttribute('data-cluster-id', 'c-p1');
  });
});

describe('<OrderByRail> lead-time zone', () => {
  const zone = (container: HTMLElement): Element | null =>
    container.querySelector('[data-testid="rail-lead-zone"]');

  const overdueFirst: OrderByRailItem[] = [
    { clusterId: 'c-late', name: 'CL-Late', orderByDate: '2020-01-01', leadTimeWeeks: 13 },
    { clusterId: 'c-p1', name: 'CL-Prod-P1', orderByDate: '2027-12-28', leadTimeWeeks: 13 },
  ];

  it('labels the zone with the lead time in days derived from leadTimeWeeks', () => {
    render(<OrderByRail items={items} />);
    expect(screen.getByText('LEAD 91 D')).toBeInTheDocument(); // 13 wk x 7
  });

  it('derives a different label from a different leadTimeWeeks', () => {
    render(<OrderByRail items={items.map((i) => ({ ...i, leadTimeWeeks: 8 }))} />);
    expect(screen.getByText('LEAD 56 D')).toBeInTheDocument(); // the 8 wk default
  });

  // Guards the issue's core constraint: the zone spans the *configured* lead
  // time, never a hardcoded 90 days. Without this, a constant would still pass
  // every label assertion above while silently drawing the wrong width.
  it.each([
    [13, 91],
    [8, 56],
  ])('sizes the zone from leadTimeWeeks (%i wk -> %i d of the 365-day rail)', (weeks, days) => {
    const { container } = render(
      <OrderByRail items={items.map((i) => ({ ...i, leadTimeWeeks: weeks }))} />,
    );
    const width = (zone(container) as HTMLElement).style.width;
    expect(Number.parseFloat(width)).toBeCloseTo((days / 365) * 100, 4);
  });

  it('clamps the zone to the rail window when the lead time exceeds 12 months', () => {
    const { container } = render(
      <OrderByRail items={items.map((i) => ({ ...i, leadTimeWeeks: 104 }))} />,
    );
    // 104 wk = 728 d, twice the window — the zone fills it rather than overflowing.
    expect(Number.parseFloat((zone(container) as HTMLElement).style.width)).toBe(100);
    expect(screen.getByText('LEAD 728 D')).toBeInTheDocument();
  });

  it('keeps the zone and label decorative, with the header hint carrying the meaning', () => {
    const { container } = render(<OrderByRail items={items} />);
    expect(screen.getByText('LEAD 91 D')).toHaveAttribute('aria-hidden');
    expect(zone(container)).toHaveAttribute('aria-hidden');
    expect(screen.getByText(/inside 91-day lead time/i)).toBeInTheDocument();
  });

  it('still renders the zone and its label when the earliest order-by is overdue', () => {
    const { container } = render(<OrderByRail items={overdueFirst} />);
    expect(zone(container)).toBeInTheDocument();
    expect(screen.getByText('LEAD 91 D')).toBeInTheDocument();
  });

  it('omits the zone when the rail has no ticks', () => {
    const { container } = render(<OrderByRail items={[]} />);
    expect(zone(container)).not.toBeInTheDocument();
    expect(screen.queryByText(/^LEAD /)).not.toBeInTheDocument();
  });

  it('omits the zone when the configured lead time is zero', () => {
    const { container } = render(
      <OrderByRail items={items.map((i) => ({ ...i, leadTimeWeeks: 0 }))} />,
    );
    expect(zone(container)).not.toBeInTheDocument();
    expect(screen.queryByText(/^LEAD /)).not.toBeInTheDocument();
  });
});
