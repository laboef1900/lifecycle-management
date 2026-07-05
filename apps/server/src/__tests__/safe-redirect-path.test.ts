import { describe, expect, it } from 'vitest';

import { safeRedirectPath } from '../routes/auth.js';

describe('safeRedirectPath', () => {
  it('accepts same-origin path-absolute targets (canonicalized)', () => {
    expect(safeRedirectPath('/')).toBe('/');
    expect(safeRedirectPath('/clusters/abc')).toBe('/clusters/abc');
    expect(safeRedirectPath('/clusters/abc?tab=hosts')).toBe('/clusters/abc?tab=hosts');
    expect(safeRedirectPath('/settings#auth')).toBe('/settings#auth');
    // Legit dot-segments still normalize and are accepted (not over-rejected).
    expect(safeRedirectPath('/foo/../bar')).toBe('/bar');
  });

  it('rejects dot-segment inputs that normalize to a protocol-relative //host (#121 F1)', () => {
    // A single leading slash passes the startsWith('//') guard, but the URL
    // parser folds the dot-segment into a //host authority — must be rejected.
    expect(safeRedirectPath('/..//evil.example.com')).toBeNull();
    expect(safeRedirectPath('/.//evil.example.com')).toBeNull();
    expect(safeRedirectPath('/../..//evil.example.com/phish')).toBeNull();
  });

  it('rejects protocol-relative and absolute URLs (open-redirect vectors)', () => {
    expect(safeRedirectPath('//evil.example.com')).toBeNull();
    expect(safeRedirectPath('//evil.example.com/phish')).toBeNull();
    expect(safeRedirectPath('https://evil.example.com')).toBeNull();
    expect(safeRedirectPath('http://evil.example.com/x')).toBeNull();
    expect(safeRedirectPath('javascript:alert(1)')).toBeNull();
  });

  it('rejects backslash tricks, control chars, and non-path input', () => {
    expect(safeRedirectPath('/\\evil.example.com')).toBeNull();
    expect(safeRedirectPath('\\\\evil.example.com')).toBeNull();
    expect(safeRedirectPath('/foo\tbar')).toBeNull();
    expect(safeRedirectPath('/foo bar')).toBeNull();
    expect(safeRedirectPath('relative/path')).toBeNull();
    expect(safeRedirectPath('')).toBeNull();
    expect(safeRedirectPath(undefined)).toBeNull();
    expect(safeRedirectPath(42)).toBeNull();
    expect(safeRedirectPath('/' + 'a'.repeat(3000))).toBeNull();
  });
});
