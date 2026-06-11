import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { StatusDot } from './status-dot';

describe('<StatusDot>', () => {
  it('is hidden from AT and tinted by tone', () => {
    const { container } = render(<StatusDot tone="crit" />);
    const dot = container.firstElementChild!;
    expect(dot).toHaveAttribute('aria-hidden', 'true');
    expect(dot.className).toContain('text-destructive');
  });

  it('paints the dot from currentColor so the halo tracks the tone', () => {
    const { container } = render(<StatusDot tone="ok" />);
    const dot = container.firstElementChild!;
    expect(dot.className).toContain('text-success');
    expect(dot.className).toContain('bg-current');
  });
});
