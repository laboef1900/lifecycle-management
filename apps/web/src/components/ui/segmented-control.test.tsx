import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { SegmentedControl } from './segmented-control';

const options = [
  { value: '12mo', label: '12 mo' },
  { value: '24mo', label: '24 mo' },
  { value: 'all', label: 'All' },
] as const;

describe('<SegmentedControl>', () => {
  it('renders a group with one pressed option', () => {
    render(
      <SegmentedControl
        ariaLabel="Forecast window"
        value="24mo"
        onValueChange={() => {}}
        options={[...options]}
      />,
    );
    expect(screen.getByRole('group', { name: 'Forecast window' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '24 mo' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '12 mo' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('reports selection changes', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(
      <SegmentedControl
        ariaLabel="Forecast window"
        value="24mo"
        onValueChange={onValueChange}
        options={[...options]}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'All' }));
    expect(onValueChange).toHaveBeenCalledWith('all');
  });
});
