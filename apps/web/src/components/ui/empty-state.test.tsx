import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { EmptyState } from './empty-state';

describe('<EmptyState>', () => {
  it('renders the title, and the description and action only when given', () => {
    const { rerender } = render(<EmptyState title="No local accounts yet" />);
    expect(screen.getByText('No local accounts yet')).toBeInTheDocument();

    rerender(
      <EmptyState
        title="No local accounts yet"
        description="Add one to sign in without an IdP."
        action={<button type="button">Add account</button>}
      />,
    );
    expect(screen.getByText('Add one to sign in without an IdP.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add account' })).toBeInTheDocument();
  });

  // The description is width-capped (`max-w-sm`/`max-w-md`) but the title is
  // not, so inside the shrink-to-fit text wrapper a title wider than the cap
  // would left-align the description unless it centres itself. Both sizes must
  // behave identically — this drifted once when `hero` was extracted.
  it.each(['default', 'hero'] as const)(
    'centres the %s description independently of the title width',
    (size) => {
      render(
        <EmptyState
          size={size}
          title="A title far wider than the description’s own max-width cap"
          description="Short."
        />,
      );
      expect(screen.getByText('Short.')).toHaveClass('mx-auto');
    },
  );

  it('lets a consumer className override the variant padding', () => {
    const { container } = render(<EmptyState title="No hosts" className="p-6" />);
    const card = container.firstElementChild;
    expect(card).toHaveClass('p-6');
    expect(card).not.toHaveClass('p-8');
  });
});
