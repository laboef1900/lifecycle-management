import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { TooltipProvider } from '@/components/ui/tooltip';

import { FleetDensityToggle, type FleetDensity } from './fleet-density';

function renderToggle(value: FleetDensity, onValueChange = vi.fn()) {
  render(
    <TooltipProvider>
      <FleetDensityToggle value={value} onValueChange={onValueChange} />
    </TooltipProvider>,
  );
  return { onValueChange };
}

describe('<FleetDensityToggle>', () => {
  it('reflects the active mode via aria-pressed', () => {
    renderToggle('compact');
    expect(screen.getByRole('button', { name: 'Compact view' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Comfortable view' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('calls onValueChange when the other mode is picked', async () => {
    const { onValueChange } = renderToggle('comfortable');
    await userEvent.click(screen.getByRole('button', { name: 'Compact view' }));
    expect(onValueChange).toHaveBeenCalledWith('compact');
  });
});
