import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { encrypt, generateSecret, loadKey } from '../crypto/secret-box.js';
import { authConfigPlugin, AuthConfigStrictBootError } from '../plugins/auth-config.js';
import { prismaPlugin } from '../plugins/prisma.js';
import { AuthConfigService } from '../services/auth-config.js';
import { prisma } from './setup.js';
import { makeTestEnv } from './test-helpers.js';

/** Seeds a stored oidc row whose secrets are encrypted under KEY. */
async function seedOidcRow(): Promise<void> {
  await prisma.authConfig.create({
    data: {
      id: 'singleton',
      mode: 'oidc',
      clientId: 'legacy',
      clientSecretEnc: encrypt('super-secret-client-secret', KEY),
      signingSecretEnc: encrypt(generateSecret(), KEY),
    },
  });
}

const KEY = loadKey(Buffer.alloc(32, 7).toString('base64'));
const KEY_B64 = KEY.toString('base64');
// A different 32-byte key, simulating an operator rotating CONFIG_ENCRYPTION_KEY
// to a new value that cannot decrypt ciphertext produced under KEY.
const WRONG_KEY = loadKey(Buffer.alloc(32, 9).toString('base64'));
const WRONG_KEY_B64 = WRONG_KEY.toString('base64');

async function buildTestServer(
  envOverrides: Parameters<typeof makeTestEnv>[0] = {},
): Promise<FastifyInstance> {
  const server = Fastify({ logger: false });
  await server.register(prismaPlugin, { prisma });
  await server.register(authConfigPlugin, { env: makeTestEnv(envOverrides) });
  return server;
}

describe('auth-config plugin', () => {
  const created: FastifyInstance[] = [];

  afterEach(async () => {
    while (created.length) {
      await created.pop()?.close();
    }
  });

  it('decorates fastify.authConfig with the seeded (default disabled) row', async () => {
    const server = await buildTestServer();
    created.push(server);

    expect(server.authConfig.current.mode).toBe('disabled');
    expect(server.authConfig.service).toBeInstanceOf(AuthConfigService);
    expect(typeof server.authConfig.reload).toBe('function');
  });

  it('reflects an existing oidc row when a key is configured', async () => {
    await prisma.authConfig.create({
      data: {
        id: 'singleton',
        mode: 'oidc',
        clientId: 'legacy',
        signingSecretEnc: encrypt(generateSecret(), KEY),
      },
    });

    const server = await buildTestServer({ CONFIG_ENCRYPTION_KEY: KEY_B64 });
    created.push(server);

    expect(server.authConfig.current.mode).toBe('oidc');
    expect(server.authConfig.current.clientId).toBe('legacy');
  });

  it('forces mode=disabled without crashing when the stored row is oidc but no encryption key is configured, preserving the encrypted secrets so a later boot with the correct key can recover', async () => {
    const clientSecretEnc = encrypt('super-secret-client-secret', KEY);
    const signingSecretEnc = encrypt(generateSecret(), KEY);
    await prisma.authConfig.create({
      data: {
        id: 'singleton',
        mode: 'oidc',
        clientId: 'legacy',
        clientSecretEnc,
        signingSecretEnc,
      },
    });

    const server = await buildTestServer({ CONFIG_ENCRYPTION_KEY: undefined });
    created.push(server);

    expect(server.authConfig.current.mode).toBe('disabled');
    const row = await prisma.authConfig.findUnique({ where: { id: 'singleton' } });
    expect(row!.mode).toBe('disabled');
    // Non-destructive recovery: the ciphertext must survive a transient/missing
    // key, so fixing CONFIG_ENCRYPTION_KEY later can decrypt and re-enable oidc.
    expect(row!.clientSecretEnc).not.toBeNull();
    expect(row!.clientSecretEnc).toBe(clientSecretEnc);
    expect(row!.signingSecretEnc).not.toBeNull();
    expect(row!.signingSecretEnc).toBe(signingSecretEnc);
  });

  it('forces mode=disabled without crashing when the stored row is oidc but CONFIG_ENCRYPTION_KEY was rotated to a different (wrong) key, preserving the encrypted secrets so rolling back the key (or re-entering the secret) can recover', async () => {
    const clientSecretEnc = encrypt('super-secret-client-secret', KEY);
    const signingSecretEnc = encrypt(generateSecret(), KEY);
    await prisma.authConfig.create({
      data: {
        id: 'singleton',
        mode: 'oidc',
        clientId: 'legacy',
        clientSecretEnc,
        signingSecretEnc,
      },
    });

    // Boot with a DIFFERENT key than the one the ciphertext was encrypted
    // under — this is the key-rotation case: the key is present (not null)
    // but wrong, so `decrypt()` throws Node's generic GCM auth-tag error
    // rather than anything mentioning CONFIG_ENCRYPTION_KEY.
    const server = await buildTestServer({ CONFIG_ENCRYPTION_KEY: WRONG_KEY_B64 });
    created.push(server);

    expect(server.authConfig.current.mode).toBe('disabled');
    const row = await prisma.authConfig.findUnique({ where: { id: 'singleton' } });
    expect(row!.mode).toBe('disabled');
    // Non-destructive recovery: the ciphertext (still under the OLD key)
    // must survive an operator's key rotation so rolling the key back, or
    // re-entering the secret via Settings to re-encrypt under the new key,
    // can recover.
    expect(row!.clientSecretEnc).not.toBeNull();
    expect(row!.clientSecretEnc).toBe(clientSecretEnc);
    expect(row!.signingSecretEnc).not.toBeNull();
    expect(row!.signingSecretEnc).toBe(signingSecretEnc);
  });

  it('forces mode=disabled without crashing when the key was rotated to a wrong value AND RECOVERY_DISABLE_AUTH=true is also set, preserving ciphertext', async () => {
    const clientSecretEnc = encrypt('super-secret-client-secret', KEY);
    const signingSecretEnc = encrypt(generateSecret(), KEY);
    await prisma.authConfig.create({
      data: {
        id: 'singleton',
        mode: 'oidc',
        clientId: 'legacy',
        clientSecretEnc,
        signingSecretEnc,
      },
    });

    const server = await buildTestServer({
      CONFIG_ENCRYPTION_KEY: WRONG_KEY_B64,
      RECOVERY_DISABLE_AUTH: true,
    });
    created.push(server);

    expect(server.authConfig.current.mode).toBe('disabled');
    const row = await prisma.authConfig.findUnique({ where: { id: 'singleton' } });
    expect(row!.mode).toBe('disabled');
    expect(row!.clientSecretEnc).toBe(clientSecretEnc);
    expect(row!.signingSecretEnc).toBe(signingSecretEnc);
  });

  it('forces mode=disabled when RECOVERY_DISABLE_AUTH=true even though the stored row is oidc', async () => {
    await prisma.authConfig.create({
      data: {
        id: 'singleton',
        mode: 'oidc',
        clientId: 'legacy',
        signingSecretEnc: encrypt(generateSecret(), KEY),
      },
    });

    const server = await buildTestServer({
      CONFIG_ENCRYPTION_KEY: KEY_B64,
      RECOVERY_DISABLE_AUTH: true,
    });
    created.push(server);

    expect(server.authConfig.current.mode).toBe('disabled');
    const row = await prisma.authConfig.findUnique({ where: { id: 'singleton' } });
    expect(row!.mode).toBe('disabled');
  });

  it('RECOVERY_DISABLE_AUTH=true with a valid key and an oidc row leaves the encrypted secrets intact', async () => {
    const clientSecretEnc = encrypt('super-secret-client-secret', KEY);
    const signingSecretEnc = encrypt(generateSecret(), KEY);
    await prisma.authConfig.create({
      data: {
        id: 'singleton',
        mode: 'oidc',
        clientId: 'legacy',
        clientSecretEnc,
        signingSecretEnc,
      },
    });

    const server = await buildTestServer({
      CONFIG_ENCRYPTION_KEY: KEY_B64,
      RECOVERY_DISABLE_AUTH: true,
    });
    created.push(server);

    expect(server.authConfig.current.mode).toBe('disabled');
    const row = await prisma.authConfig.findUnique({ where: { id: 'singleton' } });
    expect(row!.mode).toBe('disabled');
    expect(row!.clientSecretEnc).toBe(clientSecretEnc);
    expect(row!.signingSecretEnc).toBe(signingSecretEnc);
  });

  it('RECOVERY_DISABLE_AUTH=true with no encryption key and a stored oidc secret does not crash boot', async () => {
    const clientSecretEnc = 'x.y.z';
    await prisma.authConfig.create({
      data: {
        id: 'singleton',
        mode: 'oidc',
        clientId: 'legacy',
        clientSecretEnc,
      },
    });

    const server = await buildTestServer({
      CONFIG_ENCRYPTION_KEY: undefined,
      RECOVERY_DISABLE_AUTH: true,
    });
    created.push(server);

    expect(server.authConfig.current.mode).toBe('disabled');
    const row = await prisma.authConfig.findUnique({ where: { id: 'singleton' } });
    expect(row!.mode).toBe('disabled');
    expect(row!.clientSecretEnc).not.toBeNull();
    expect(row!.clientSecretEnc).toBe(clientSecretEnc);
  });

  it('reload() picks up an out-of-band row change', async () => {
    const server = await buildTestServer({ CONFIG_ENCRYPTION_KEY: KEY_B64 });
    created.push(server);

    expect(server.authConfig.current.mode).toBe('disabled');

    await prisma.authConfig.update({
      where: { id: 'singleton' },
      data: {
        mode: 'oidc',
        clientId: 'new-client',
        signingSecretEnc: encrypt(generateSecret(), KEY),
      },
    });

    // Not yet reflected until reload() is called.
    expect(server.authConfig.current.mode).toBe('disabled');

    await server.authConfig.reload();

    expect(server.authConfig.current.mode).toBe('oidc');
    expect(server.authConfig.current.clientId).toBe('new-client');
  });
});

describe('auth-config plugin — AUTH_STRICT_BOOT', () => {
  const created: FastifyInstance[] = [];

  afterEach(async () => {
    while (created.length) {
      await created.pop()?.close();
    }
  });

  it('refuses to boot (throws) when a configured secret cannot be decrypted, leaving the row intact', async () => {
    await seedOidcRow();

    const server = Fastify({ logger: false });
    // Register without awaiting so the plugin runs at ready(), not eagerly.
    server.register(prismaPlugin, { prisma });
    server.register(authConfigPlugin, {
      env: makeTestEnv({ CONFIG_ENCRYPTION_KEY: WRONG_KEY_B64, AUTH_STRICT_BOOT: true }),
    });
    created.push(server);

    await expect(server.ready()).rejects.toBeInstanceOf(AuthConfigStrictBootError);

    // The configured row is preserved (not force-disabled) so restoring the key recovers it.
    const row = await prisma.authConfig.findUnique({ where: { id: 'singleton' } });
    expect(row!.mode).toBe('oidc');
    expect(row!.clientSecretEnc).not.toBeNull();
  });

  it('RECOVERY_DISABLE_AUTH overrides strict boot: degrades to disabled instead of crashing', async () => {
    await seedOidcRow();

    const server = Fastify({ logger: false });
    await server.register(prismaPlugin, { prisma });
    await server.register(authConfigPlugin, {
      env: makeTestEnv({
        CONFIG_ENCRYPTION_KEY: WRONG_KEY_B64,
        AUTH_STRICT_BOOT: true,
        RECOVERY_DISABLE_AUTH: true,
      }),
    });
    created.push(server);

    expect(server.authConfig.current.mode).toBe('disabled');
  });

  it('does not bite a fresh/disabled deployment (no configured secret to decrypt)', async () => {
    const server = Fastify({ logger: false });
    await server.register(prismaPlugin, { prisma });
    await server.register(authConfigPlugin, { env: makeTestEnv({ AUTH_STRICT_BOOT: true }) });
    created.push(server);

    expect(server.authConfig.current.mode).toBe('disabled');
  });

  it('boots normally when strict is on and the configured secret decrypts', async () => {
    await seedOidcRow();

    const server = Fastify({ logger: false });
    await server.register(prismaPlugin, { prisma });
    await server.register(authConfigPlugin, {
      env: makeTestEnv({ CONFIG_ENCRYPTION_KEY: KEY_B64, AUTH_STRICT_BOOT: true }),
    });
    created.push(server);

    expect(server.authConfig.current.mode).toBe('oidc');
  });
});
