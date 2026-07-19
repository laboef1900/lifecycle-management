import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { HostStateBadge } from '../host-state-badge';

describe('HostStateBadge', () => {
  it('renders the human label for in_service', () => {
    render(<HostStateBadge state="in_service" />);
    expect(screen.getByText(/in service/i)).toBeInTheDocument();
  });

  it('uses the warning color class for degraded', () => {
    const { container } = render(<HostStateBadge state="degraded" />);
    expect(container.firstChild?.textContent).toMatch(/degraded/i);
    expect((container.firstChild as HTMLElement).className).toMatch(/text-warning/);
  });

  it('renders ALL-CAPS labels, matching every other status-class badge in the app (#243 Part B copy item 2)', () => {
    // Previously sentence-case ('In service') beside the app's other
    // status-class badges (cluster-tile.tsx's OK/WARN/CRIT,
    // recommendation-chip.tsx's ORDER NOW/PLANNED, FlagChip's BASELINE/EVENT
    // chips) — all ALL-CAPS. One casing rule now, not two.
    render(<HostStateBadge state="in_service" />);
    expect(screen.getByText('IN SERVICE')).toBeInTheDocument();
    expect(screen.queryByText('In service')).toBeNull();
  });

  it('renders every state label in ALL-CAPS', () => {
    const expected: Record<string, string> = {
      ordered: 'ORDERED',
      racked: 'RACKED',
      in_service: 'IN SERVICE',
      degraded: 'DEGRADED',
      decommissioned: 'DECOMMISSIONED',
      disposed: 'DISPOSED',
    };
    for (const [state, label] of Object.entries(expected)) {
      const { unmount } = render(
        <HostStateBadge state={state as Parameters<typeof HostStateBadge>[0]['state']} />,
      );
      expect(screen.getByText(label)).toBeInTheDocument();
      unmount();
    }
  });
});
