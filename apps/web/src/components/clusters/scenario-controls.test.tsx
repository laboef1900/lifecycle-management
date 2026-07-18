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

  it('seeds the draft from the active scenario, so Apply cannot silently replace it with the defaults', async () => {
    // The pane unmounts on close (#226), so every reopen is a fresh mount: a
    // form showing "Lose hosts / 1" beside "Active: Delay procurement by 6 mo"
    // turns one Apply click into an unintended scenario swap.
    const onChange = vi.fn();
    render(
      <ScenarioControls active={{ kind: 'delay_procurement', months: 6 }} onChange={onChange} />,
    );

    expect(screen.getByLabelText(/delay \(months\)/i)).toHaveValue(6);
    expect(screen.queryByLabelText(/hosts to drop/i)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /apply/i }));
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'delay_procurement', months: 6 });
  });

  it('seeds both add_vms fields from the active scenario', () => {
    render(
      <ScenarioControls active={{ kind: 'add_vms', count: 30, sizeGb: 64 }} onChange={() => {}} />,
    );
    expect(screen.getByLabelText(/vm count/i)).toHaveValue(30);
    expect(screen.getByLabelText(/size \(gb\)/i)).toHaveValue(64);
  });

  it('falls back to the defaults when no scenario is active', () => {
    render(<ScenarioControls active={null} onChange={() => {}} />);
    expect(screen.getByLabelText(/hosts to drop/i)).toHaveValue(1);
  });

  it('stacks the fields instead of using the viewport-wide 12-column row', () => {
    // The only host is the cluster panel's ~272px Scenario pane, where the old
    // `sm:col-span-*` row squeezed the number inputs to ~39px. jsdom has no
    // layout, so the guard is on the layout classes themselves.
    render(
      <ScenarioControls active={{ kind: 'add_vms', count: 30, sizeGb: 64 }} onChange={() => {}} />,
    );
    const fields = screen.getByTestId('scenario-fields');
    expect(fields).not.toHaveClass('grid-cols-12');
    expect(fields.querySelector('[class*="sm:col-span-"]')).toBeNull();
  });
});
