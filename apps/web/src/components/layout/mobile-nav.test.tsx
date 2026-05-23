import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { MobileNavProvider, MobileNavTrigger, useMobileNav } from './mobile-nav';

function StateProbe(): React.JSX.Element {
  const { open } = useMobileNav();
  return <span data-testid="probe">{open ? 'open' : 'closed'}</span>;
}

describe('<MobileNavProvider> + <MobileNavTrigger>', () => {
  it('starts closed and opens when the trigger is clicked', async () => {
    const user = userEvent.setup();
    render(
      <MobileNavProvider>
        <MobileNavTrigger />
        <StateProbe />
      </MobileNavProvider>,
    );
    expect(screen.getByTestId('probe')).toHaveTextContent('closed');
    await user.click(screen.getByRole('button', { name: /open navigation/i }));
    expect(screen.getByTestId('probe')).toHaveTextContent('open');
  });

  it('exposes setOpen so consumers can close the sheet on navigation', async () => {
    function CloseProbe(): React.JSX.Element {
      const { setOpen } = useMobileNav();
      return (
        <button type="button" onClick={() => setOpen(false)}>
          close-from-probe
        </button>
      );
    }
    const user = userEvent.setup();
    render(
      <MobileNavProvider>
        <MobileNavTrigger />
        <CloseProbe />
        <StateProbe />
      </MobileNavProvider>,
    );
    await user.click(screen.getByRole('button', { name: /open navigation/i }));
    expect(screen.getByTestId('probe')).toHaveTextContent('open');
    await user.click(screen.getByText('close-from-probe'));
    expect(screen.getByTestId('probe')).toHaveTextContent('closed');
  });
});
