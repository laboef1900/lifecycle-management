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

  it('coalesces a rapid drag into ONE emit, not one per slider tick', async () => {
    const onChange = vi.fn();
    render(
      <ScenarioControls
        active={{ kind: 'lose_hosts', count: 1 }}
        onChange={onChange}
        maxHosts={9}
      />,
    );
    const slider = screen.getByLabelText('Hosts lost');

    // A drag is a burst of change events; each one restarts the debounce.
    fireEvent.change(slider, { target: { value: '4' } });
    fireEvent.change(slider, { target: { value: '5' } });
    fireEvent.change(slider, { target: { value: '6' } });

    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ kind: 'lose_hosts', count: 6 }));
    // The whole point of the debounce: the intermediate positions never became
    // their own scenario-forecast POST.
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('flushes a pending edit on unmount instead of dropping it', () => {
    const onChange = vi.fn();
    const { unmount } = render(
      <ScenarioControls
        active={{ kind: 'lose_hosts', count: 1 }}
        onChange={onChange}
        maxHosts={9}
      />,
    );

    fireEvent.change(screen.getByLabelText('Hosts lost'), { target: { value: '7' } });
    expect(onChange).not.toHaveBeenCalled(); // still inside the debounce window

    // Unmount happens when the rail closes AND when it moves between its docked
    // and inline render sites at the `lg` boundary. Neither is a "discard".
    unmount();

    expect(onChange).toHaveBeenCalledWith({ kind: 'lose_hosts', count: 7 });
  });

  it('disables the hosts slider until the forecast reports the host count', () => {
    const onChange = vi.fn();
    render(<ScenarioControls active={{ kind: 'lose_hosts', count: 2 }} onChange={onChange} />);

    // No maxHosts ⇒ the bound is unknown. Inventing one is how a count larger
    // than the cluster's real host list would reach the parent.
    const slider = screen.getByLabelText('Hosts lost');
    expect(slider).toBeDisabled();
    expect(slider).toHaveAccessibleDescription(/waiting for the forecast/i);
  });

  it('never emits more lost hosts than the cluster has, even from a seeded draft', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    // An applied "lose 5" against a cluster the forecast now reports as 3 hosts.
    render(
      <ScenarioControls
        active={{ kind: 'lose_hosts', count: 5 }}
        onChange={onChange}
        maxHosts={3}
      />,
    );

    // The control shows the truth it can honour, not the stale 5.
    expect(screen.getByLabelText('Hosts lost')).toHaveValue('3');

    // …and anything it emits is clamped too, not just what it displays.
    await user.click(screen.getByTestId('scenario-preset-add_vms'));
    await user.click(screen.getByTestId('scenario-preset-lose_hosts'));
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'lose_hosts', count: 3 });
  });

  it('bounds the VM-count and delay sliders', () => {
    const { unmount } = render(
      <ScenarioControls active={{ kind: 'add_vms', count: 20, sizeGb: 16 }} onChange={() => {}} />,
    );
    expect(screen.getByLabelText('VM count')).toHaveAttribute('max', '100');
    expect(screen.getByLabelText('VM count')).toHaveAttribute('min', '1');
    unmount();

    render(
      <ScenarioControls active={{ kind: 'delay_procurement', months: 2 }} onChange={() => {}} />,
    );
    expect(screen.getByLabelText('Delay (months)')).toHaveAttribute('max', '24');
    expect(screen.getByLabelText('Delay (months)')).toHaveAttribute('min', '1');
  });
});
