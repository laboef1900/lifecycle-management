import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Dialog, DialogContent, DialogTitle } from './dialog';

describe('<DialogContent> close button', () => {
  it('gives the close control a 32px icon hit area, not the content-sized icon alone', () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Example</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    const close = screen.getByRole('button', { name: 'Close' });
    expect(close.className).toContain('h-8');
    expect(close.className).toContain('w-8');
  });

  it('does not carry its own focus: utilities that would suppress the global focus-visible ring', () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Example</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    const close = screen.getByRole('button', { name: 'Close' });
    expect(close.className).not.toContain('focus:outline-none');
    expect(close.className).not.toContain('focus:ring');
  });
});
