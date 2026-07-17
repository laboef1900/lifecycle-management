import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { BulletMeter } from './bullet-meter';

describe('<BulletMeter>', () => {
  it('exposes value and thresholds via an accessible name', () => {
    render(<BulletMeter value={62.3} warn={70} crit={90} />);
    const meter = screen.getByRole('img');
    expect(meter.getAttribute('aria-label')).toMatch(/62\.3/);
    expect(meter.getAttribute('aria-label')).toMatch(/70/);
    expect(meter.getAttribute('aria-label')).toMatch(/90/);
  });

  it('accepts a custom label', () => {
    render(<BulletMeter value={10} warn={70} crit={90} label="Custom label text" />);
    expect(screen.getByRole('img', { name: 'Custom label text' })).toBeInTheDocument();
  });

  it('positions the fill width from value', () => {
    render(<BulletMeter value={45} warn={70} crit={90} />);
    const fill = screen.getByTestId('bullet-meter-fill');
    expect(fill.style.width).toBe('45%');
  });

  it('clamps the fill width to [0, 100]', () => {
    const { rerender } = render(<BulletMeter value={140} warn={70} crit={90} />);
    expect(screen.getByTestId('bullet-meter-fill').style.width).toBe('100%');
    rerender(<BulletMeter value={-10} warn={70} crit={90} />);
    expect(screen.getByTestId('bullet-meter-fill').style.width).toBe('0%');
  });

  it('positions the warn and crit ticks', () => {
    render(<BulletMeter value={45} warn={70} crit={90} />);
    expect(screen.getByTestId('bullet-meter-warn-tick').style.left).toBe('70%');
    expect(screen.getByTestId('bullet-meter-crit-tick').style.left).toBe('90%');
  });
});
