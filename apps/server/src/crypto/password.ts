import { hash, verify } from '@node-rs/argon2';

/**
 * OWASP-tuned argon2id parameters. Encapsulated here so the algorithm and
 * cost can evolve in one place (mirrors crypto/secret-box.ts). @node-rs/argon2
 * defaults to Argon2id, so only the cost fields below need setting.
 */
const OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1, outputLen: 32 } as const;

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
