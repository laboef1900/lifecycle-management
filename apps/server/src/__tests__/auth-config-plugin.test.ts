import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { encrypt, generateSecret, loadKey } from '../crypto/secret-box.js';
import authConfigPlugin from '../plugins/auth-config.js';
import prismaPlugin from '../plugins/prisma.js';
import { AuthConfigService } from '../services/auth-config.js';
import { prisma } from './setup.js';
import { makeTestEnv } from './test-helpers.js';

const KEY = loadKey(Buffer.alloc(32, 7).toString('base64'));
const KEY_B64 = KEY.toString('base64');

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
