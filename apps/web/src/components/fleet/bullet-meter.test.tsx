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

  it('keeps threshold ticks visible on any fill: surface halo, no alpha (#243 Part B High-1)', () => {
    render(<BulletMeter value={85} warn={70} crit={90} />);
    const warnTick = screen.getByTestId('bullet-meter-warn-tick');
    const critTick = screen.getByTestId('bullet-meter-crit-tick');
    // 1px halo in the card surface color — survives the amber fill even where
    // dark-theme --warning === --accent (the vanishing-tick failure mode).
    expect(warnTick).toHaveClass('shadow-[0_0_0_1px_var(--card)]');
    expect(critTick).toHaveClass('shadow-[0_0_0_1px_var(--card)]');
    // Full opacity: 70% amber over amber was half the vanishing act.
    expect(warnTick.className).not.toMatch(/bg-warning\/\d/);
    expect(critTick.className).not.toMatch(/bg-destructive\/\d/);
  });

  it('differentiates crit from warn by shape — taller tick, not hue alone (WCAG 1.4.1)', () => {
    render(<BulletMeter value={45} warn={70} crit={90} />);
    expect(screen.getByTestId('bullet-meter-warn-tick')).toHaveClass('-top-0.5', '-bottom-0.5');
    expect(screen.getByTestId('bullet-meter-crit-tick')).toHaveClass('-top-1', '-bottom-1');
  });
});
