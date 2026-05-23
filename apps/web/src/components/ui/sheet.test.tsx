import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { Sheet, SheetContent, SheetTitle, SheetTrigger } from './sheet';

describe('<Sheet>', () => {
  it('opens via the trigger and closes on Escape', async () => {
    const user = userEvent.setup();
    render(
      <Sheet>
        <SheetTrigger>Open</SheetTrigger>
        <SheetContent>
          <SheetTitle className="sr-only">Nav</SheetTitle>
          <a href="/">Home</a>
        </SheetContent>
      </Sheet>,
    );

    expect(screen.queryByRole('dialog', { name: 'Nav' })).toBeNull();
    await user.click(screen.getByText('Open'));
    expect(await screen.findByRole('dialog', { name: 'Nav' })).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Nav' })).toBeNull();
  });

  it('renders a close button inside the sheet content', async () => {
    const user = userEvent.setup();
    render(
      <Sheet>
        <SheetTrigger>Open</SheetTrigger>
        <SheetContent>
          <SheetTitle className="sr-only">Nav</SheetTitle>
          <span>content</span>
        </SheetContent>
      </Sheet>,
    );

    await user.click(screen.getByText('Open'));
    const close = await screen.findByRole('button', { name: /close/i });
    await user.click(close);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
