import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ScenarioControls, describeScenario } from './scenario-controls';

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
  it('renders three preset chips, none active, and no tuning slider until one is picked', () => {
    render(<ScenarioControls active={null} onChange={() => {}} />);
    for (const kind of ['lose_hosts', 'add_vms', 'delay_procurement'] as const) {
      expect(screen.getByTestId(`scenario-preset-${kind}`)).toHaveAttribute(
        'aria-pressed',
        'false',
      );
    }
    expect(screen.queryByLabelText('Hosts lost')).toBeNull();
  });

  it('selecting a preset applies its scenario immediately — no Apply step', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ScenarioControls active={null} onChange={onChange} />);

    await user.click(screen.getByTestId('scenario-preset-lose_hosts'));

    expect(onChange).toHaveBeenLastCalledWith({ kind: 'lose_hosts', count: 1 });
    expect(screen.getByTestId('scenario-preset-lose_hosts')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByLabelText('Hosts lost')).toBeInTheDocument();
    // The old dropdown + Apply button are gone.
    expect(screen.queryByRole('button', { name: /apply/i })).toBeNull();
  });

  it('bounds the lose-hosts slider by the cluster host count and redraws live on drag', async () => {
    const onChange = vi.fn();
    render(
      <ScenarioControls
        active={{ kind: 'lose_hosts', count: 1 }}
        onChange={onChange}
        maxHosts={6}
      />,
    );
    const slider = screen.getByLabelText('Hosts lost');
    expect(slider).toHaveAttribute('max', '6');

    fireEvent.change(slider, { target: { value: '3' } });

    // Debounced: the forecast redraws without an Apply click.
    await waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith({ kind: 'lose_hosts', count: 3 }),
    );
  });

  it('re-tapping the active preset returns to the baseline (null)', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ScenarioControls active={{ kind: 'lose_hosts', count: 2 }} onChange={onChange} />);

    await user.click(screen.getByTestId('scenario-preset-lose_hosts'));

    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('seeds add_vms from the active scenario and emits on a size-tier tap', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ScenarioControls active={{ kind: 'add_vms', count: 30, sizeGb: 64 }} onChange={onChange} />,
    );

    expect(screen.getByLabelText('VM count')).toHaveAttribute('aria-valuetext', '30 VMs');
    expect(screen.getByTestId('scenario-size-64')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('scenario-total')).toHaveTextContent(/1920 GB added/); // 30 × 64

    await user.click(screen.getByTestId('scenario-size-32'));
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'add_vms', count: 30, sizeGb: 32 });
  });

  it('seeds the delay slider from the active scenario and hides the others', () => {
    render(
      <ScenarioControls active={{ kind: 'delay_procurement', months: 6 }} onChange={() => {}} />,
    );
    expect(screen.getByLabelText('Delay (months)')).toHaveAttribute('aria-valuetext', '6 months');
    expect(screen.queryByLabelText('Hosts lost')).toBeNull();
  });

  it('shows the active scenario summary', () => {
    render(
      <ScenarioControls active={{ kind: 'add_vms', count: 30, sizeGb: 16 }} onChange={() => {}} />,
    );
    expect(screen.getByTestId('scenario-summary')).toHaveTextContent(/Add 30 × 16 GB VMs/);
  });
});
