import { describe, expect, it } from 'vitest';

import { userInitials } from '@/components/layout/user-menu';

describe('userInitials', () => {
  it('derives initials from display name, email, or falls back', () => {
    expect(userInitials('Ada Lovelace', null)).toBe('AL');
    expect(userInitials(null, 'grace.hopper@example.com')).toBe('GH');
    expect(userInitials('Plato', null)).toBe('P');
    expect(userInitials(null, null)).toBe('?');
    expect(userInitials('', 'grace.hopper@example.com')).toBe('GH');
  });
});
