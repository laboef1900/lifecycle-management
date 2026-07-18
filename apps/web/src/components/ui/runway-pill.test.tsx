import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { RunwayPill } from './runway-pill';

describe('<RunwayPill>', () => {
  it('renders months until warn with an accent variant when >= 12', () => {
    render(<RunwayPill summary={{ months: 18, alreadyBreached: false }} />);
    const pill = screen.getByText(/18 mo to 70%/i);
    expect(pill).toBeInTheDocument();
    expect(pill.parentElement).toHaveAttribute('data-variant', 'accent');
  });

  it('uses the amber variant when months < 12', () => {
    render(<RunwayPill summary={{ months: 5, alreadyBreached: false }} />);
    const pill = screen.getByText(/5 mo to 70%/i);
    expect(pill.parentElement).toHaveAttribute('data-variant', 'warning');
  });

  it('uses the danger variant when months < 3', () => {
    render(<RunwayPill summary={{ months: 2, alreadyBreached: false }} />);
    const pill = screen.getByText(/2 mo to 70%/i);
    expect(pill.parentElement).toHaveAttribute('data-variant', 'danger');
  });

  it('shows "Over 70%" amber when already breached at warn', () => {
    render(<RunwayPill summary={{ months: 0, alreadyBreached: 'warn' }} />);
    const pill = screen.getByText(/Over 70%/i);
    expect(pill.parentElement).toHaveAttribute('data-variant', 'warning');
  });

  it('shows "Over 90%" red when already breached at crit', () => {
    render(<RunwayPill summary={{ months: 0, alreadyBreached: 'crit' }} />);
    const pill = screen.getByText(/Over 90%/i);
    expect(pill.parentElement).toHaveAttribute('data-variant', 'danger');
  });

  it('shows the horizon hint with a "+" and accent variant when there is no projected breach', () => {
    render(<RunwayPill summary={{ months: null, alreadyBreached: false }} horizonMonths={24} />);
    const pill = screen.getByText(/24\+ mo/i);
    expect(pill).toBeInTheDocument();
    expect(pill.parentElement).toHaveAttribute('data-variant', 'accent');
  });

  it('shows unknown instead of a synthetic runway when capacity is missing', () => {
    render(
      <RunwayPill summary={{ months: null, alreadyBreached: false }} unknown horizonMonths={24} />,
    );
    const pill = screen.getByText(/unknown — no capacity/i);
    expect(pill.parentElement).toHaveAttribute('data-variant', 'outline');
    expect(screen.queryByText(/24\+ mo/i)).toBeNull();
  });

  it('renders em-dash when the summary is undefined', () => {
    render(<RunwayPill summary={undefined} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('falls back to "No breach in horizon" copy when no horizonMonths is given', () => {
    render(<RunwayPill summary={{ months: null, alreadyBreached: false }} />);
    expect(screen.getByText(/No breach in horizon/i)).toBeInTheDocument();
  });

  describe('with custom cluster thresholds', () => {
    const custom = { warn: 0.45, crit: 0.48 };

    it('labels the runway with the custom warn percentage', () => {
      render(<RunwayPill summary={{ months: 4, alreadyBreached: false }} thresholds={custom} />);
      expect(screen.getByText(/4 mo to 45%/i)).toBeInTheDocument();
    });

    it('uses the custom crit percentage in the breached-crit label', () => {
      render(<RunwayPill summary={{ months: 0, alreadyBreached: 'crit' }} thresholds={custom} />);
      expect(screen.getByText(/Over 48%/i)).toBeInTheDocument();
    });

    it('uses the custom warn percentage in the breached-warn label', () => {
      render(<RunwayPill summary={{ months: 0, alreadyBreached: 'warn' }} thresholds={custom} />);
      expect(screen.getByText(/Over 45%/i)).toBeInTheDocument();
    });
  });
});
