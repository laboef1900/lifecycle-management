import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('motion/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('motion/react')>();
  return { ...actual, useReducedMotion: () => true };
});

import { AnimatedNumber } from './animated-number';

describe('<AnimatedNumber>', () => {
  it('renders the formatted final value when reduced motion is preferred', () => {
    render(<AnimatedNumber value={78.4} format={(v) => `${v.toFixed(1)}%`} />);
    expect(screen.getByText('78.4%')).toBeInTheDocument();
  });

  it('defaults to a locale-rounded integer', () => {
    render(<AnimatedNumber value={4302.4} />);
    expect(screen.getByText('4,302')).toBeInTheDocument();
  });
});
