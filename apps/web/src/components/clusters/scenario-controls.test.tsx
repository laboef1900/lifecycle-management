import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { ScenarioControls, describeScenario } from './scenario-controls';

// Radix Select uses pointer APIs jsdom doesn't implement; stub the lot.
beforeAll(() => {
  if (!('hasPointerCapture' in HTMLElement.prototype)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (HTMLElement.prototype as any).hasPointerCapture = () => false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (HTMLElement.prototype as any).setPointerCapture = () => {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (HTMLElement.prototype as any).releasePointerCapture = () => {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (HTMLElement.prototype as any).scrollIntoView = () => {};
  }
});

describe('describeScenario', () => {
  it('produces singular/plural copy for lose_hosts', () => {
    expect(describeScenario({ kind: 'lose_hosts', count: 1 })).toBe('Lose 1 host');
    expect(describeScenario({ kind: 'lose_hosts', count: 3 })).toBe('Lose 3 hosts');
  });

  it('shows count × size for add_vms', () => {
    expect(describeScenario({ kind: 'add_vms', count: 20, sizeGb: 16 })).toBe('Add 20 × 16 GB VMs');
  });

  it('shows months for delay_procurement', () => {
    expect(describeScenario({ kind: 'delay_procurement', months: 6 })).toBe(
      'Delay procurement by 6 mo',
    );
  });
});

describe('<ScenarioControls>', () => {
  it('emits a lose_hosts scenario with the typed count when Apply is clicked', async () => {
    const onChange = vi.fn();
    render(<ScenarioControls active={null} onChange={onChange} />);
    const countInput = screen.getByLabelText(/hosts to drop/i);
    await userEvent.clear(countInput);
    await userEvent.type(countInput, '2');
    await userEvent.click(screen.getByRole('button', { name: /apply/i }));
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'lose_hosts', count: 2 });
  });

  it('rejects a count below 1 with an inline alert (no onChange)', async () => {
    const onChange = vi.fn();
    render(<ScenarioControls active={null} onChange={onChange} />);
    const countInput = screen.getByLabelText(/hosts to drop/i);
    await userEvent.clear(countInput);
    await userEvent.type(countInput, '0');
    await userEvent.click(screen.getByRole('button', { name: /apply/i }));
    expect(screen.getByRole('alert')).toHaveTextContent(/count must be/i);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('shows the Clear button only when a scenario is active and emits null on click', async () => {
    const onChange = vi.fn();
    const { rerender } = render(<ScenarioControls active={null} onChange={onChange} />);
    expect(screen.queryByTestId('scenario-clear')).not.toBeInTheDocument();
    rerender(<ScenarioControls active={{ kind: 'lose_hosts', count: 1 }} onChange={onChange} />);
    await userEvent.click(screen.getByTestId('scenario-clear'));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('renders the active scenario summary', () => {
    render(
      <ScenarioControls active={{ kind: 'add_vms', count: 30, sizeGb: 16 }} onChange={() => {}} />,
    );
    expect(screen.getByTestId('scenario-summary')).toHaveTextContent(/Add 30 × 16 GB VMs/);
  });
});
