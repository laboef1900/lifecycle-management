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
