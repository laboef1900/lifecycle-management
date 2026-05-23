import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { UtilizationGauge } from './utilization-gauge';

describe('<UtilizationGauge>', () => {
  it('renders the percentage as text with one decimal', () => {
    render(<UtilizationGauge value={0.482} />);
    expect(screen.getByText('48.2%')).toBeInTheDocument();
  });

  it('reports an accessible name describing the status band', () => {
    render(<UtilizationGauge value={0.5} aria-labelledby="gauge-label" />);
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
});
