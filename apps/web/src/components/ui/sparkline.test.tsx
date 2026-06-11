import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Sparkline } from './sparkline';

describe('<Sparkline>', () => {
  it('maps values to a polyline spanning the viewBox', () => {
    const { container } = render(<Sparkline values={[0, 5, 10]} width={60} height={20} />);
    const polyline = container.querySelector('polyline')!;
    const points = polyline
      .getAttribute('points')!
      .split(' ')
      .map((p) => p.split(',').map(Number));
    expect(points).toHaveLength(3);
    expect(points[0]![0]).toBe(0); // first x at left edge
    expect(points[2]![0]).toBe(60); // last x at right edge
    expect(points[0]![1]).toBeGreaterThan(points[2]![1]!); // min renders lower than max
  });

  it('renders an empty placeholder for fewer than two values', () => {
    const { container } = render(<Sparkline values={[7]} />);
    expect(container.querySelector('polyline')).toBeNull();
  });
});
