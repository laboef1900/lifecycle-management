import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ScenarioControls, describeScenario, describeScenarioStack } from './scenario-controls';

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

describe('describeScenarioStack', () => {
  it('joins steps with " + " — simultaneous conditions, not a sequence', () => {
    expect(
      describeScenarioStack([
        { kind: 'lose_hosts', count: 2 },
        { kind: 'delay_procurement', months: 3 },
      ]),
    ).toBe('Lose 2 hosts + Delay procurement by 3 mo');
  });

  it('lists steps in canonical order regardless of the order they were built in', () => {
    // Same stack, opposite input order → identical phrase. This string drives the
    // header indicator, the live region and the chart legend, so it must not
    // wobble with the order the user happened to tap.
    const a = describeScenarioStack([
      { kind: 'delay_procurement', months: 3 },
      { kind: 'add_vms', count: 4, sizeGb: 8 },
      { kind: 'lose_hosts', count: 1 },
    ]);
    const b = describeScenarioStack([
      { kind: 'lose_hosts', count: 1 },
      { kind: 'delay_procurement', months: 3 },
      { kind: 'add_vms', count: 4, sizeGb: 8 },
    ]);
    expect(a).toBe(b);
    expect(a).toBe('Lose 1 host + Add 4 × 8 GB VMs + Delay procurement by 3 mo');
  });

  it('renders a single step as just that step, with no join artefacts', () => {
    expect(describeScenarioStack([{ kind: 'lose_hosts', count: 1 }])).toBe('Lose 1 host');
  });

  it('returns empty string for an empty stack (callers gate on length)', () => {
    expect(describeScenarioStack([])).toBe('');
  });
});

describe('<ScenarioControls>', () => {
  it('renders three preset chips, none active, and no tuning slider until one is picked', () => {
    render(<ScenarioControls active={[]} onChange={() => {}} />);
    for (const kind of ['lose_hosts', 'add_vms', 'delay_procurement'] as const) {
      expect(screen.getByTestId(`scenario-preset-${kind}`)).toHaveAttribute(
        'aria-pressed',
        'false',
      );
    }
    expect(screen.queryByLabelText('Hosts lost')).toBeNull();
    expect(screen.queryByTestId('scenario-stack')).toBeNull();
  });

  it('selecting a preset applies its scenario immediately — no Apply step', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ScenarioControls active={[]} onChange={onChange} />);

    await user.click(screen.getByTestId('scenario-preset-lose_hosts'));

    expect(onChange).toHaveBeenLastCalledWith([{ kind: 'lose_hosts', count: 1 }]);
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
        active={[{ kind: 'lose_hosts', count: 1 }]}
        onChange={onChange}
        maxHosts={6}
      />,
    );
    const slider = screen.getByLabelText('Hosts lost');
    expect(slider).toHaveAttribute('max', '6');

    fireEvent.change(slider, { target: { value: '3' } });

    // Debounced: the forecast redraws without an Apply click.
    await waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith([{ kind: 'lose_hosts', count: 3 }]),
    );
  });

  it('re-tapping an applied preset removes that step, returning to the baseline', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ScenarioControls active={[{ kind: 'lose_hosts', count: 2 }]} onChange={onChange} />);

    await user.click(screen.getByTestId('scenario-preset-lose_hosts'));

    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it('seeds add_vms from the active scenario and emits on a size-tier tap', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ScenarioControls
        active={[{ kind: 'add_vms', count: 30, sizeGb: 64 }]}
        onChange={onChange}
      />,
    );

    expect(screen.getByLabelText('VM count')).toHaveAttribute('aria-valuetext', '30 VMs');
    expect(screen.getByTestId('scenario-size-64')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('scenario-total')).toHaveTextContent(/1920 GB added/); // 30 × 64

    await user.click(screen.getByTestId('scenario-size-32'));
    expect(onChange).toHaveBeenLastCalledWith([{ kind: 'add_vms', count: 30, sizeGb: 32 }]);
  });

  it('seeds the delay slider from the active scenario and hides the others', () => {
    render(
      <ScenarioControls active={[{ kind: 'delay_procurement', months: 6 }]} onChange={() => {}} />,
    );
    expect(screen.getByLabelText('Delay (months)')).toHaveAttribute('aria-valuetext', '6 months');
    expect(screen.queryByLabelText('Hosts lost')).toBeNull();
  });

  it('shows the active scenario summary', () => {
    render(
      <ScenarioControls
        active={[{ kind: 'add_vms', count: 30, sizeGb: 16 }]}
        onChange={() => {}}
      />,
    );
    expect(screen.getByTestId('scenario-summary')).toHaveTextContent(/Add 30 × 16 GB VMs/);
  });

  it('coalesces a rapid drag into ONE emit, not one per slider tick', async () => {
    const onChange = vi.fn();
    render(
      <ScenarioControls
        active={[{ kind: 'lose_hosts', count: 1 }]}
        onChange={onChange}
        maxHosts={9}
      />,
    );
    const slider = screen.getByLabelText('Hosts lost');

    // A drag is a burst of change events; each one restarts the debounce.
    fireEvent.change(slider, { target: { value: '4' } });
    fireEvent.change(slider, { target: { value: '5' } });
    fireEvent.change(slider, { target: { value: '6' } });

    await waitFor(() => expect(onChange).toHaveBeenCalledWith([{ kind: 'lose_hosts', count: 6 }]));
    // The whole point of the debounce: the intermediate positions never became
    // their own scenario-forecast POST.
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('flushes a pending edit on unmount instead of dropping it', () => {
    const onChange = vi.fn();
    const { unmount } = render(
      <ScenarioControls
        active={[{ kind: 'lose_hosts', count: 1 }]}
        onChange={onChange}
        maxHosts={9}
      />,
    );

    fireEvent.change(screen.getByLabelText('Hosts lost'), { target: { value: '7' } });
    expect(onChange).not.toHaveBeenCalled(); // still inside the debounce window

    // Unmount happens when the rail closes AND when it moves between its docked
    // and inline render sites at the `lg` boundary. Neither is a "discard".
    unmount();

    expect(onChange).toHaveBeenCalledWith([{ kind: 'lose_hosts', count: 7 }]);
  });

  it('disables the hosts slider until the forecast reports the host count', () => {
    const onChange = vi.fn();
    render(<ScenarioControls active={[{ kind: 'lose_hosts', count: 2 }]} onChange={onChange} />);

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
        active={[{ kind: 'lose_hosts', count: 5 }]}
        onChange={onChange}
        maxHosts={3}
      />,
    );

    // The control shows the truth it can honour, not the stale 5.
    expect(screen.getByLabelText('Hosts lost')).toHaveValue('3');

    // …and anything it emits is clamped too, not just what it displays. Adding a
    // second step re-emits the whole stack, so the clamp has to survive the fold.
    await user.click(screen.getByTestId('scenario-preset-add_vms'));
    expect(onChange).toHaveBeenLastCalledWith([
      { kind: 'lose_hosts', count: 3 },
      { kind: 'add_vms', count: 20, sizeGb: 16 },
    ]);
  });

  it('disables a blocked preset, states the reason, and refuses to emit it', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ScenarioControls
        active={[]}
        onChange={onChange}
        maxHosts={4}
        blocked={{ lose_hosts: 'no host has a recorded capacity in this window.' }}
      />,
    );

    const preset = screen.getByTestId('scenario-preset-lose_hosts');
    expect(preset).toHaveAttribute('aria-disabled', 'true');
    // The reason is TEXT, not just a dimmed chip: a disabled control that never
    // explains itself reads as broken, and dimming is a colour-only signal.
    expect(preset).toHaveAccessibleDescription(/no host has a recorded capacity/i);
    expect(screen.getByText(/no host has a recorded capacity/i)).toBeInTheDocument();

    await user.click(preset);
    expect(onChange).not.toHaveBeenCalled();
    // Only the inapplicable preset is gated. `aria-disabled` is what gates these
    // chips (they stay focusable so the reason can be announced), so assert that
    // attribute rather than `toBeEnabled()`, which only reads native `disabled`
    // and would pass even on a fully gated chip.
    expect(screen.getByTestId('scenario-preset-add_vms')).toHaveAttribute('aria-disabled', 'false');
  });

  it('never blocks a preset that is already in the stack — its chip is a way out', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ScenarioControls
        active={[{ kind: 'delay_procurement', months: 3 }]}
        onChange={onChange}
        blocked={{ delay_procurement: 'there is no order date to delay.' }}
      />,
    );

    const preset = screen.getByTestId('scenario-preset-delay_procurement');
    expect(preset).toHaveAttribute('aria-disabled', 'false');

    await user.click(preset);
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it('bounds the VM-count and delay sliders', () => {
    const { unmount } = render(
      <ScenarioControls
        active={[{ kind: 'add_vms', count: 20, sizeGb: 16 }]}
        onChange={() => {}}
      />,
    );
    expect(screen.getByLabelText('VM count')).toHaveAttribute('max', '100');
    expect(screen.getByLabelText('VM count')).toHaveAttribute('min', '1');
    unmount();

    render(
      <ScenarioControls active={[{ kind: 'delay_procurement', months: 2 }]} onChange={() => {}} />,
    );
    expect(screen.getByLabelText('Delay (months)')).toHaveAttribute('max', '24');
    expect(screen.getByLabelText('Delay (months)')).toHaveAttribute('min', '1');
  });
});

describe('<ScenarioControls> — compound stack (#323)', () => {
  it('stacks a second what-if instead of replacing the first', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ScenarioControls active={[]} onChange={onChange} maxHosts={5} />);

    await user.click(screen.getByTestId('scenario-preset-lose_hosts'));
    await user.click(screen.getByTestId('scenario-preset-delay_procurement'));

    expect(onChange).toHaveBeenLastCalledWith([
      { kind: 'lose_hosts', count: 1 },
      { kind: 'delay_procurement', months: 2 },
    ]);
    // Both chips read as pressed, and both tuning rows are on screen at once —
    // the previous UI could only ever show one.
    expect(screen.getByTestId('scenario-preset-lose_hosts')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByTestId('scenario-preset-delay_procurement')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByLabelText('Hosts lost')).toBeInTheDocument();
    expect(screen.getByLabelText('Delay (months)')).toBeInTheDocument();
  });

  it('emits steps in canonical order even when built back-to-front', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ScenarioControls active={[]} onChange={onChange} maxHosts={5} />);

    // Tap in reverse of the canonical order.
    await user.click(screen.getByTestId('scenario-preset-delay_procurement'));
    await user.click(screen.getByTestId('scenario-preset-add_vms'));
    await user.click(screen.getByTestId('scenario-preset-lose_hosts'));

    expect(onChange).toHaveBeenLastCalledWith([
      { kind: 'lose_hosts', count: 1 },
      { kind: 'add_vms', count: 20, sizeGb: 16 },
      { kind: 'delay_procurement', months: 2 },
    ]);
    // …and the rows render in that same order, so the rail reads consistently.
    const rows = screen.getAllByTestId(/^scenario-step-(lose_hosts|add_vms|delay_procurement)$/);
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual([
      'scenario-step-lose_hosts',
      'scenario-step-add_vms',
      'scenario-step-delay_procurement',
    ]);
  });

  it('removes one step via its own Remove control and keeps the rest', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ScenarioControls
        active={[
          { kind: 'lose_hosts', count: 2 },
          { kind: 'delay_procurement', months: 4 },
        ]}
        onChange={onChange}
        maxHosts={5}
      />,
    );

    await user.click(screen.getByTestId('scenario-step-remove-lose_hosts'));

    expect(onChange).toHaveBeenLastCalledWith([{ kind: 'delay_procurement', months: 4 }]);
    expect(screen.queryByLabelText('Hosts lost')).toBeNull();
    expect(screen.getByLabelText('Delay (months)')).toBeInTheDocument();
  });

  it('names each Remove control after its step, so three of them are distinguishable', () => {
    render(
      <ScenarioControls
        active={[
          { kind: 'lose_hosts', count: 1 },
          { kind: 'add_vms', count: 10, sizeGb: 8 },
          { kind: 'delay_procurement', months: 1 },
        ]}
        onChange={() => {}}
        maxHosts={5}
      />,
    );
    for (const label of ['Lose hosts', 'Add load', 'Delay order']) {
      expect(
        screen.getByRole('button', { name: `Remove ${label} from the scenario` }),
      ).toBeInTheDocument();
    }
  });

  it('seeds every row from a compound stack, not just the first', () => {
    render(
      <ScenarioControls
        active={[
          { kind: 'lose_hosts', count: 3 },
          { kind: 'add_vms', count: 40, sizeGb: 32 },
          { kind: 'delay_procurement', months: 9 },
        ]}
        onChange={() => {}}
        maxHosts={5}
      />,
    );
    expect(screen.getByLabelText('Hosts lost')).toHaveValue('3');
    expect(screen.getByLabelText('VM count')).toHaveValue('40');
    expect(screen.getByTestId('scenario-size-32')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('Delay (months)')).toHaveValue('9');
  });

  it('summarises the whole compound, not one step of it', () => {
    render(
      <ScenarioControls
        active={[
          { kind: 'lose_hosts', count: 2 },
          { kind: 'delay_procurement', months: 3 },
        ]}
        onChange={() => {}}
        maxHosts={5}
      />,
    );
    expect(screen.getByTestId('scenario-summary')).toHaveTextContent(
      'Active: Lose 2 hosts + Delay procurement by 3 mo',
    );
  });

  it('re-emits the whole stack when one row is tuned', async () => {
    const onChange = vi.fn();
    render(
      <ScenarioControls
        active={[
          { kind: 'lose_hosts', count: 1 },
          { kind: 'delay_procurement', months: 2 },
        ]}
        onChange={onChange}
        maxHosts={8}
      />,
    );

    fireEvent.change(screen.getByLabelText('Delay (months)'), { target: { value: '7' } });

    // The untouched lose_hosts step must survive the edit — dropping it would
    // silently narrow the what-if the chart is showing.
    await waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith([
        { kind: 'lose_hosts', count: 1 },
        { kind: 'delay_procurement', months: 7 },
      ]),
    );
  });
});
