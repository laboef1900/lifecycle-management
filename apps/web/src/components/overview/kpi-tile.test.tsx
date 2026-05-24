import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { KpiTile } from './kpi-tile';

describe('<KpiTile>', () => {
  it('renders the value in monospace and shows an accent left bar for attention status', () => {
    const { container } = render(
      <KpiTile
        label="Fleet runway"
        value="14 mo"
        status="attention"
        caption="no projected breach"
      />,
    );
    expect(screen.getByText('14 mo')).toHaveClass('font-mono');
    const root = container.firstChild as HTMLElement;
    expect(root.className).toMatch(/border-l-2/);
    expect(root.className).toMatch(/border-l-accent/);
  });

  it('omits the left accent bar for ok status', () => {
    const { container } = render(<KpiTile label="Clusters" value="8" status="ok" />);
    const root = container.firstChild as HTMLElement;
    expect(root.className).not.toMatch(/border-l-2/);
  });

  it('uses the warning left bar for warn status', () => {
    const { container } = render(<KpiTile label="Util" value="78%" status="warn" />);
    const root = container.firstChild as HTMLElement;
    expect(root.className).toMatch(/border-l-warning/);
  });

  it('uses the destructive left bar for crit status', () => {
    const { container } = render(<KpiTile label="Util" value="95%" status="crit" />);
    const root = container.firstChild as HTMLElement;
    expect(root.className).toMatch(/border-l-destructive/);
  });
});
