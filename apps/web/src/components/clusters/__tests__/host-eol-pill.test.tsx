import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HostEolPill } from '../host-eol-pill';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-05-25'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('HostEolPill', () => {
  it('renders nothing when eolAt is null', () => {
    const { container } = render(<HostEolPill eolAt={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders just the date when EOL is far (>180d)', () => {
    render(<HostEolPill eolAt="2030-01-01" />);
    expect(screen.getByText('2030-01-01')).toBeInTheDocument();
    expect(screen.queryByText(/⚠/)).toBeNull();
  });

  it('renders the warning pill within 180 days', () => {
    render(<HostEolPill eolAt="2026-08-15" />);
    expect(screen.getByText(/⚠/)).toBeInTheDocument();
  });
});
