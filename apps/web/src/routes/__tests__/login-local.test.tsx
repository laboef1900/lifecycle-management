import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { LocalLoginForm } from '../login.js';

describe('LocalLoginForm', () => {
  it('renders username and password inputs', () => {
    render(<LocalLoginForm redirect={undefined} />);
    expect(screen.getByLabelText(/username/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
  });
});
