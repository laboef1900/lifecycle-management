import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { WindowControls } from './window-controls';

describe('<WindowControls>', () => {
  it('never wraps a segment label internally, even under compression (#243 Part B item 6)', () => {
    // 390px: window-controls.tsx buttons lacked `whitespace-nowrap` (Button's
    // base has it; this control doesn't use Button), so the active "24 mo"
    // segment wrapped to two lines ("24" over "mo") when the Forecast heading
    // row squeezed it into leftover width.
    render(<WindowControls value="24mo" onChange={vi.fn()} />);

    for (const label of ['12 mo', '24 mo', 'All']) {
      expect(screen.getByRole('button', { name: label })).toHaveClass('whitespace-nowrap');
    }
  });

  it('marks the active window with aria-pressed and calls onChange with the clicked value', () => {
    const onChange = vi.fn();
    render(<WindowControls value="12mo" onChange={onChange} />);

    expect(screen.getByRole('button', { name: '12 mo' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '24 mo' })).toHaveAttribute('aria-pressed', 'false');

    screen.getByRole('button', { name: 'All' }).click();
    expect(onChange).toHaveBeenCalledWith('all');
  });
});
