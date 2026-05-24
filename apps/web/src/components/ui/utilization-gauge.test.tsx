import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { UtilizationGauge } from './utilization-gauge';

describe('<UtilizationGauge>', () => {
  it('renders the percentage as text with one decimal', () => {
    render(<UtilizationGauge value={0.482} />);
    expect(screen.getByText('48.2%')).toBeInTheDocument();
  });

  it('reports an accessible name describing the status band', () => {
    render(<UtilizationGauge value={0.5} />);
    const gauge = screen.getByRole('img');
    expect(gauge).toHaveAccessibleName(/50\.0%, status: ok/i);
  });

  it('reports the warning band for values in [0.7, 0.9)', () => {
    render(<UtilizationGauge value={0.75} />);
    expect(screen.getByRole('img')).toHaveAccessibleName(/status: warning/i);
  });

  it('reports the critical band at or above 0.9', () => {
    render(<UtilizationGauge value={0.95} />);
    expect(screen.getByRole('img')).toHaveAccessibleName(/status: critical/i);
  });

  it('renders an em-dash and a neutral status when value is undefined', () => {
    render(<UtilizationGauge value={undefined} />);
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.getByRole('img')).toHaveAccessibleName(/status: empty/i);
  });

  it('renders 0.0% at the low boundary', () => {
    render(<UtilizationGauge value={0} />);
    expect(screen.getByText('0.0%')).toBeInTheDocument();
    expect(screen.getByRole('img')).toHaveAccessibleName(/status: ok/i);
  });

  it('renders 100.0% and the critical band at full', () => {
    render(<UtilizationGauge value={1} />);
    expect(screen.getByText('100.0%')).toBeInTheDocument();
    expect(screen.getByRole('img')).toHaveAccessibleName(/status: critical/i);
  });

  it('clamps values above 1 to 100.0%', () => {
    render(<UtilizationGauge value={1.5} />);
    expect(screen.getByText('100.0%')).toBeInTheDocument();
  });

  it('renders a 96px lg gauge when size="lg"', () => {
    const { container } = render(<UtilizationGauge value={0.5} size="lg" />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('width', '96');
    expect(svg).toHaveAttribute('height', '96');
  });

  it('renders a 28px sm gauge when size="sm"', () => {
    const { container } = render(<UtilizationGauge value={0.5} size="sm" />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('width', '28');
  });

  it('uses custom warn/crit thresholds when provided', () => {
    render(<UtilizationGauge value={0.65} warn={0.6} crit={0.8} />);
    expect(screen.getByRole('img', { name: /, status: warning/i })).toBeInTheDocument();
  });
});
