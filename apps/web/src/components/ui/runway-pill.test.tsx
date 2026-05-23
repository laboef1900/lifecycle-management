import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { RunwayPill } from './runway-pill';

describe('<RunwayPill>', () => {
  it('renders months until warn with a success variant when >= 12', () => {
    render(<RunwayPill summary={{ months: 18, alreadyBreached: false }} />);
    const pill = screen.getByText(/18 mo to 70%/i);
    expect(pill).toBeInTheDocument();
    expect(pill.parentElement?.className).toMatch(/success/);
  });

  it('uses the amber variant when months < 12', () => {
    render(<RunwayPill summary={{ months: 5, alreadyBreached: false }} />);
    const pill = screen.getByText(/5 mo to 70%/i);
    expect(pill.parentElement?.className).toMatch(/warning/);
  });

  it('uses the red variant when months < 3', () => {
    render(<RunwayPill summary={{ months: 2, alreadyBreached: false }} />);
    const pill = screen.getByText(/2 mo to 70%/i);
    expect(pill.parentElement?.className).toMatch(/destructive/);
  });

  it('shows "Over 70%" amber when already breached at warn', () => {
    render(<RunwayPill summary={{ months: 0, alreadyBreached: 'warn' }} />);
    const pill = screen.getByText(/Over 70%/i);
    expect(pill.parentElement?.className).toMatch(/warning/);
  });

  it('shows "Over 90%" red when already breached at crit', () => {
    render(<RunwayPill summary={{ months: 0, alreadyBreached: 'crit' }} />);
    const pill = screen.getByText(/Over 90%/i);
    expect(pill.parentElement?.className).toMatch(/destructive/);
  });

  it('shows the horizon hint with a "+" when there is no projected breach', () => {
    render(<RunwayPill summary={{ months: null, alreadyBreached: false }} horizonMonths={24} />);
    expect(screen.getByText(/24\+ mo/i)).toBeInTheDocument();
  });

  it('renders em-dash when the summary is undefined', () => {
    render(<RunwayPill summary={undefined} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});
