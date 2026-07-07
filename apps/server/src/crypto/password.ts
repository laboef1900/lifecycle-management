import { hash, verify, type Algorithm } from '@node-rs/argon2';

/**
 * `@node-rs/argon2` exports `Algorithm` as an ambient `const enum`, which
 * TypeScript's `isolatedModules` (required repo-wide) forbids referencing by
 * value (TS2748: "Cannot access ambient const enums"). `2` is
 * `Algorithm.Argon2id` per the installed package's generated `.d.ts`; the
 * type annotation still checks it against the real enum type, and the
 * PHC-prefix test in password.test.ts pins the resulting hash algorithm.
 */
const ARGON2ID: Algorithm = 2;

/**
 * OWASP-tuned argon2id parameters. Encapsulated here so the algorithm and
 * cost can evolve in one place (mirrors crypto/secret-box.ts). The algorithm
 * is now set explicitly rather than relying on @node-rs/argon2's default.
 */
const OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const;

/** Returns a self-contained argon2id PHC string (salt embedded). */
export function hashPassword(plain: string): Promise<string> {
  return hash(plain, OPTIONS);
}

/**
 * Constant-ish-time verify. Returns false (never throws) for a malformed or
 * empty stored hash, so callers can treat "no credential" and "wrong
 * credential" identically without special-casing.
 */
export async function verifyPassword(hashed: string, plain: string): Promise<boolean> {
  try {
    return await verify(hashed, plain);
  } catch {
    return false;
  }
}
