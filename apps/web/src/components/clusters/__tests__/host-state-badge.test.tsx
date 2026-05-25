import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { HostStateBadge } from '../host-state-badge';

describe('HostStateBadge', () => {
  it('renders the human label for in_service', () => {
    render(<HostStateBadge state="in_service" />);
    expect(screen.getByText(/in service/i)).toBeInTheDocument();
  });

  it('uses the amber color class for degraded', () => {
    const { container } = render(<HostStateBadge state="degraded" />);
    expect(container.firstChild?.textContent).toMatch(/degraded/i);
    expect((container.firstChild as HTMLElement).className).toMatch(/amber/);
  });
});
