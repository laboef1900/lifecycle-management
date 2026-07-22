import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { encrypt, generateSecret, loadKey } from '../crypto/secret-box.js';
import {
  authConfigPlugin,
  AuthConfigStrictBootError,
  degradeWouldWidenAccess,
} from '../plugins/auth-config.js';
import { prismaPlugin } from '../plugins/prisma.js';
import { AuthConfigService, AuthSecretDecryptError } from '../services/auth-config.js';
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

/** pino's numeric level for `error` — asserted so a downgrade to warn fails. */
const PINO_ERROR_LEVEL = 50;

/**
 * Same as `buildTestServer`, but with a REAL logger writing JSON lines into an
 * array. `logger: false` installs a no-op logger, which makes every log-level
 * assertion vacuously true — the divergence alarm's whole value is its
 * severity, so it has to be observed on the wire.
 */
async function buildLoggingTestServer(
  envOverrides: Parameters<typeof makeTestEnv>[0] = {},
): Promise<{ server: FastifyInstance; lines: Array<Record<string, unknown>> }> {
  const lines: Array<Record<string, unknown>> = [];
  const server = Fastify({
    logger: {
      level: 'trace',
      stream: {
        write(line: string) {
          lines.push(JSON.parse(line) as Record<string, unknown>);
        },
      },
    },
  });
  await server.register(prismaPlugin, { prisma });
  await server.register(authConfigPlugin, { env: makeTestEnv(envOverrides) });
  return { server, lines };
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
    // In-memory degrade only (#222): the stored mode is preserved so restoring
    // CONFIG_ENCRYPTION_KEY alone recovers the deployment as it was.
    expect(row!.mode).toBe('oidc');
    expect(server.authConfig.storedMode).toBe('oidc');
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
    // In-memory degrade only (#222) — rolling the key back is enough to recover.
    expect(row!.mode).toBe('oidc');
    expect(server.authConfig.storedMode).toBe('oidc');
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
    // Both overrides fire on this boot; neither writes the mode (#222).
    expect(row!.mode).toBe('oidc');
    expect(server.authConfig.storedMode).toBe('oidc');
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
    // The override is in-memory only (#222): the stored oidc row survives.
    expect(row!.mode).toBe('oidc');
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
    expect(row!.mode).toBe('oidc');
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
    expect(row!.mode).toBe('oidc');
    expect(row!.clientSecretEnc).not.toBeNull();
    expect(row!.clientSecretEnc).toBe(clientSecretEnc);
  });

  it('RECOVERY_DISABLE_AUTH=true overrides the mode in memory only, leaving the stored oidc row untouched', async () => {
    const clientSecretEnc = encrypt('super-secret-client-secret', KEY);
    await prisma.authConfig.create({
      data: {
        id: 'singleton',
        mode: 'oidc',
        clientId: 'legacy',
        clientSecretEnc,
        signingSecretEnc: encrypt(generateSecret(), KEY),
      },
    });

    const server = await buildTestServer({
      CONFIG_ENCRYPTION_KEY: KEY_B64,
      RECOVERY_DISABLE_AUTH: true,
    });
    created.push(server);

    expect(server.authConfig.current.mode).toBe('disabled');
    expect(server.authConfig.storedMode).toBe('oidc');
    expect(server.authConfig.breakGlass).toBe(true);
    expect(server.authConfig.overrideCause).toBe('break_glass');
    const row = await prisma.authConfig.findUnique({ where: { id: 'singleton' } });
    expect(row!.mode).toBe('oidc');
    expect(row!.clientSecretEnc).toBe(clientSecretEnc);
  });

  it('the break-glass override masks ONLY the mode — decrypted secrets stay in memory', async () => {
    // Invariant 9. §6A/§6B recovery (rotate-signing-secret, re-testing
    // discovery, saving without re-entering the client secret) all read these
    // off `current` DURING a break-glass boot. A regression that nulled them
    // would break recovery silently: `current.mode` assertions alone pass.
    await prisma.authConfig.create({
      data: {
        id: 'singleton',
        mode: 'oidc',
        clientId: 'legacy',
        clientSecretEnc: encrypt('super-secret-client-secret', KEY),
        signingSecretEnc: encrypt('a-signing-secret-value', KEY),
      },
    });

    const server = await buildTestServer({
      CONFIG_ENCRYPTION_KEY: KEY_B64,
      RECOVERY_DISABLE_AUTH: true,
    });
    created.push(server);

    expect(server.authConfig.current.mode).toBe('disabled');
    expect(server.authConfig.current.clientSecret).toBe('super-secret-client-secret');
    expect(server.authConfig.current.signingSecret).toBe('a-signing-secret-value');
    // Every other field is passed through untouched as well.
    expect(server.authConfig.current.clientId).toBe('legacy');

    // ...and still after a reload(), where the override is re-applied.
    await server.authConfig.reload();
    expect(server.authConfig.current.mode).toBe('disabled');
    expect(server.authConfig.current.clientSecret).toBe('super-secret-client-secret');
    expect(server.authConfig.current.signingSecret).toBe('a-signing-secret-value');
  });

  it('restores the stored oidc mode on the next boot once RECOVERY_DISABLE_AUTH is cleared', async () => {
    await prisma.authConfig.create({
      data: {
        id: 'singleton',
        mode: 'oidc',
        clientId: 'legacy',
        signingSecretEnc: encrypt(generateSecret(), KEY),
      },
    });

    const first = await buildTestServer({
      CONFIG_ENCRYPTION_KEY: KEY_B64,
      RECOVERY_DISABLE_AUTH: true,
    });
    expect(first.authConfig.current.mode).toBe('disabled');
    await first.close();

    // Second boot against the SAME row, flag cleared — this is the documented
    // "clear the flag and restart to resume normal operation" procedure.
    const second = await buildTestServer({ CONFIG_ENCRYPTION_KEY: KEY_B64 });
    created.push(second);

    expect(second.authConfig.current.mode).toBe('oidc');
    expect(second.authConfig.current.clientId).toBe('legacy');
    expect(second.authConfig.breakGlass).toBe(false);
  });

  it('the break-glass override survives reload()', async () => {
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

    // rotate-signing-secret (and any other Settings write) calls reload();
    // if the override were a one-time boot event the operator would be locked
    // out again on the very next request, mid-recovery.
    await server.authConfig.reload();

    expect(server.authConfig.current.mode).toBe('disabled');
    expect(server.authConfig.storedMode).toBe('oidc');
  });

  it('reload() refreshes storedMode when break-glass is not active', async () => {
    const server = await buildTestServer({ CONFIG_ENCRYPTION_KEY: KEY_B64 });
    created.push(server);

    expect(server.authConfig.storedMode).toBe('disabled');

    await prisma.authConfig.update({
      where: { id: 'singleton' },
      data: {
        mode: 'oidc',
        clientId: 'new-client',
        signingSecretEnc: encrypt(generateSecret(), KEY),
      },
    });

    await server.authConfig.reload();

    // A stale storedMode would round-trip the OLD mode back into the DB
    // through the Settings form (sanitize() reports storedMode).
    expect(server.authConfig.storedMode).toBe('oidc');
  });

  it('leaves a stored local-mode row intact through a break-glass boot', async () => {
    await prisma.authConfig.create({ data: { id: 'singleton', mode: 'local' } });

    const server = await buildTestServer({ RECOVERY_DISABLE_AUTH: true });
    created.push(server);

    expect(server.authConfig.current.mode).toBe('disabled');
    expect(server.authConfig.storedMode).toBe('local');
    const row = await prisma.authConfig.findUnique({ where: { id: 'singleton' } });
    expect(row!.mode).toBe('local');
  });

  it('the decrypt-failure degrade leaves the stored oidc mode intact', async () => {
    // OIDC is the ONE mode that still degrades: it is the only mode that reads
    // the encrypted columns at boot, so it is the only mode a key failure can
    // affect (#241). This path is deliberately preserved, not weakened.
    const clientSecretEnc = encrypt('super-secret-client-secret', KEY);
    await prisma.authConfig.create({
      data: {
        id: 'singleton',
        mode: 'oidc',
        clientId: 'legacy',
        clientSecretEnc,
        signingSecretEnc: encrypt(generateSecret(), KEY),
      },
    });

    const server = await buildTestServer({ CONFIG_ENCRYPTION_KEY: WRONG_KEY_B64 });
    created.push(server);

    expect(server.authConfig.current.mode).toBe('disabled');
    expect(server.authConfig.storedMode).toBe('oidc');
    expect(server.authConfig.breakGlass).toBe(false);
    // The divergence has a recorded cause even though break-glass is off —
    // this is what lets sanitize() flag a decrypt-degraded boot (#222).
    expect(server.authConfig.overrideCause).toBe('secret_decrypt_failure');
    const row = await prisma.authConfig.findUnique({ where: { id: 'singleton' } });
    expect(row!.mode).toBe('oidc');
    expect(row!.clientSecretEnc).toBe(clientSecretEnc);
  });

  it('a stored LOCAL row with undecryptable leftover ciphertext keeps enforcing local WITHOUT strict boot (#241)', async () => {
    // The sibling of the strict-boot case below, and the more important one:
    // the deployments most exposed to this fail-open are precisely those that
    // never opted into AUTH_STRICT_BOOT. Closing it must not depend on the
    // flag. Before #241 this boot produced `current.mode === 'disabled'` with
    // overrideCause `secret_decrypt_failure` — an open, anonymous-ADMIN API for
    // a deployment configured closed.
    const signingSecretEnc = encrypt(generateSecret(), KEY);
    await prisma.authConfig.create({
      data: { id: 'singleton', mode: 'local', clientId: 'legacy', signingSecretEnc },
    });

    const server = await buildTestServer({ CONFIG_ENCRYPTION_KEY: WRONG_KEY_B64 });
    created.push(server);

    expect(server.authConfig.current.mode).toBe('local');
    expect(server.authConfig.storedMode).toBe('local');
    expect(server.authConfig.overrideCause).toBeNull();
    expect(server.authConfig.current.signingSecret).toBeNull();
    const row = await prisma.authConfig.findUnique({ where: { id: 'singleton' } });
    expect(row!.mode).toBe('local');
    expect(row!.signingSecretEnc).toBe(signingSecretEnc);
  });

  it('records break_glass as the cause when BOTH overrides fire on the same boot', async () => {
    // Precedence: break-glass is the operator's deliberate, immediately
    // reversible action, so it names the recovery to try first. Fixing the key
    // alone would not lift the override.
    await seedOidcRow();

    const server = await buildTestServer({
      CONFIG_ENCRYPTION_KEY: WRONG_KEY_B64,
      RECOVERY_DISABLE_AUTH: true,
    });
    created.push(server);

    expect(server.authConfig.current.mode).toBe('disabled');
    expect(server.authConfig.storedMode).toBe('oidc');
    expect(server.authConfig.overrideCause).toBe('break_glass');
  });

  it('records no cause on a normal boot with no override', async () => {
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
    expect(server.authConfig.overrideCause).toBeNull();
  });

  it('reload() refreshes storedMode even when the re-read cannot decrypt', async () => {
    // Invariant 4's stale window: a write lands, the subsequent reload() throws
    // AuthSecretDecryptError, and storedMode would otherwise keep its
    // pre-write value — round-tripping the OLD mode back into the DB through
    // the Settings form (sanitize() reports storedMode).
    const server = await buildTestServer({ CONFIG_ENCRYPTION_KEY: KEY_B64 });
    created.push(server);
    expect(server.authConfig.storedMode).toBe('disabled');

    // The row now says oidc but its secret is encrypted under a key this
    // process does not have.
    await prisma.authConfig.update({
      where: { id: 'singleton' },
      data: { mode: 'oidc', clientId: 'new-client', clientSecretEnc: encrypt('s', WRONG_KEY) },
    });

    await expect(server.authConfig.reload()).rejects.toBeInstanceOf(AuthSecretDecryptError);

    expect(server.authConfig.storedMode).toBe('oidc');
    // The failed reload must never widen what is enforced.
    expect(server.authConfig.current.mode).toBe('disabled');
  });

  it('emits the open_despite_configuration alarm at error level when reload() opens a RUNTIME divergence', async () => {
    // The boot-time alarm (authStartupWarnings) only ever runs once, at boot.
    // A divergence that OPENS mid-process — a write lands, the re-read cannot
    // decrypt, `current` stays `disabled` while `storedMode` advances to a
    // configured mode — produced no signal at all: the deployment silently
    // transitions to "open despite configuration" with nothing in the logs
    // between boot and the next restart.
    const { server, lines } = await buildLoggingTestServer({ CONFIG_ENCRYPTION_KEY: KEY_B64 });
    created.push(server);

    const alarms = (): Array<Record<string, unknown>> =>
      lines.filter((l) => l.event === 'auth_config.open_despite_configuration');

    // Booted clean: stored and enforced agree, so nothing is raised yet. This
    // half also proves the alarm is not fired unconditionally.
    expect(server.authConfig.current.mode).toBe('disabled');
    expect(server.authConfig.storedMode).toBe('disabled');
    expect(alarms()).toHaveLength(0);

    // The row now says oidc but its secret is encrypted under a key this
    // process does not have — reload() refreshes storedMode and rethrows.
    await prisma.authConfig.update({
      where: { id: 'singleton' },
      data: { mode: 'oidc', clientId: 'new-client', clientSecretEnc: encrypt('s', WRONG_KEY) },
    });

    await expect(server.authConfig.reload()).rejects.toBeInstanceOf(AuthSecretDecryptError);

    expect(server.authConfig.current.mode).toBe('disabled');
    expect(server.authConfig.storedMode).toBe('oidc');

    const raised = alarms();
    expect(raised).toHaveLength(1);
    // Severity is the point: an incident-grade fact must not ship as a warn.
    expect(raised[0]!.level).toBe(PINO_ERROR_LEVEL);
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

  it('does not refuse boot for an intentionally-disabled row that still holds an undecryptable secret (#126 F1)', async () => {
    // Historically: oidc -> disabled via Settings left clientSecretEnc
    // populated, and a later key rotation made it undecryptable; the row was
    // already disabled, so failing open was not a downgrade and strict boot had
    // to spare it. Since #241 the row is not even read — decryption is gated on
    // the stored mode — so there is no failure to spare. Rows in this exact
    // shape still exist on deployments that switched to disabled before #241,
    // which is why this stays pinned.
    await prisma.authConfig.create({
      data: {
        id: 'singleton',
        mode: 'disabled',
        clientId: 'legacy',
        clientSecretEnc: encrypt('super-secret-client-secret', KEY),
        signingSecretEnc: encrypt(generateSecret(), KEY),
      },
    });

    const server = Fastify({ logger: false });
    server.register(prismaPlugin, { prisma });
    server.register(authConfigPlugin, {
      env: makeTestEnv({ CONFIG_ENCRYPTION_KEY: WRONG_KEY_B64, AUTH_STRICT_BOOT: true }),
    });
    created.push(server);

    await expect(server.ready()).resolves.toBeDefined();
    expect(server.authConfig.current.mode).toBe('disabled');
    // Leftover ciphertext is preserved so restoring the key can recover it.
    const row = await prisma.authConfig.findUnique({ where: { id: 'singleton' } });
    expect(row!.clientSecretEnc).not.toBeNull();
  });

  it('refuses the boot AFTER a decrypt degrade, because the degrade no longer disables the stored row (#222)', async () => {
    // Pre-#222 the decrypt degrade rewrote the row to `disabled`, so the next
    // strict boot sailed through into an open API. The row is now preserved as
    // `oidc`, so strict boot correctly keeps refusing until the key is fixed —
    // the whole point of the opt-in flag.
    await seedOidcRow();

    const degraded = Fastify({ logger: false });
    await degraded.register(prismaPlugin, { prisma });
    await degraded.register(authConfigPlugin, {
      env: makeTestEnv({ CONFIG_ENCRYPTION_KEY: WRONG_KEY_B64 }),
    });
    expect(degraded.authConfig.current.mode).toBe('disabled');
    expect(degraded.authConfig.storedMode).toBe('oidc');
    await degraded.close();

    const strict = Fastify({ logger: false });
    strict.register(prismaPlugin, { prisma });
    strict.register(authConfigPlugin, {
      env: makeTestEnv({ CONFIG_ENCRYPTION_KEY: WRONG_KEY_B64, AUTH_STRICT_BOOT: true }),
    });
    created.push(strict);

    await expect(strict.ready()).rejects.toBeInstanceOf(AuthConfigStrictBootError);
  });

  it('BOOTS and keeps enforcing LOCAL when a stored local row holds undecryptable leftover ciphertext (#241)', async () => {
    // This test used to assert the OPPOSITE — "refuses to boot when the stored
    // mode is LOCAL and its secret cannot be decrypted" — and that refusal was
    // the #222 fix: `toEffective()` decrypted every secret column regardless of
    // the row's mode, so a configured LOCAL deployment whose leftover OIDC
    // ciphertext went unreadable DEGRADED to `mode=disabled`, i.e. an
    // anonymous-ADMIN open API. Strict boot was the opt-in way to refuse that
    // downgrade.
    //
    // #241 closes the fail-open at the SOURCE rather than refusing its symptom:
    // decryption is gated on the stored mode, so a `local` row never reads the
    // encrypted columns, never degrades, and leaves strict boot nothing to
    // refuse. The guarantee is strictly stronger than the old refusal — the
    // deployment keeps ENFORCING `local` instead of going down. This is NOT a
    // return to the pre-#222 `=== 'oidc'` scoping bug: the strict-boot predicate
    // is still the divergence test `!== 'disabled'`; it simply is no longer
    // reachable for `local`.
    await prisma.authConfig.create({
      data: {
        id: 'singleton',
        mode: 'local',
        signingSecretEnc: encrypt(generateSecret(), KEY),
      },
    });

    const server = Fastify({ logger: false });
    server.register(prismaPlugin, { prisma });
    server.register(authConfigPlugin, {
      env: makeTestEnv({ CONFIG_ENCRYPTION_KEY: WRONG_KEY_B64, AUTH_STRICT_BOOT: true }),
    });
    created.push(server);

    await expect(server.ready()).resolves.toBeDefined();

    // Still CLOSED — the security property #241 delivers.
    expect(server.authConfig.current.mode).toBe('local');
    expect(server.authConfig.storedMode).toBe('local');
    // No degrade happened at all, so there is no cause to attribute.
    expect(server.authConfig.overrideCause).toBeNull();
    expect(server.authConfig.current.signingSecret).toBeNull();

    // The row and its (now unread) ciphertext are untouched.
    const row = await prisma.authConfig.findUnique({ where: { id: 'singleton' } });
    expect(row!.mode).toBe('local');
    expect(row!.signingSecretEnc).not.toBeNull();
  });

  it('RECOVERY_DISABLE_AUTH still masks a stored LOCAL row to disabled under strict boot', async () => {
    // Break-glass is unaffected by #241: it is a separate, deliberate override
    // that masks whatever the stored mode is. It no longer has a decrypt
    // refusal to escape (the row above now boots enforcing `local`), but it
    // remains the documented way out when the operator has locked themselves
    // out of a local deployment some other way.
    await prisma.authConfig.create({
      data: {
        id: 'singleton',
        mode: 'local',
        signingSecretEnc: encrypt(generateSecret(), KEY),
      },
    });

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
    expect(server.authConfig.storedMode).toBe('local');
    expect(server.authConfig.breakGlass).toBe(true);
    expect(server.authConfig.overrideCause).toBe('break_glass');
    const row = await prisma.authConfig.findUnique({ where: { id: 'singleton' } });
    expect(row!.mode).toBe('local');
  });

  it('#136 F1 REGRESSION GUARD: a stored DISABLED row with stale undecryptable ciphertext must STILL BOOT under strict boot — do not re-narrow this to "any secret failure refuses"', async () => {
    // The exemption is now STRUCTURAL rather than a carve-out in the
    // strict-boot predicate: since #241 gated decryption on the stored mode, a
    // `disabled` row never reads its leftover ciphertext, so no decrypt failure
    // is raised, no degrade fires, and the strict-boot guard is never consulted
    // in the first place. Before #241 the row DID throw and was spared only by
    // the predicate's `!== 'disabled'` test (#136 F1,
    // docs/pr-review-2026-07.md:71).
    //
    // The outcome this guard exists to protect is unchanged and still asserted:
    // the app's documented default posture — a disabled deployment carrying
    // leftover ciphertext from an earlier oidc configuration — must boot, not
    // suffer a spurious outage.
    await prisma.authConfig.create({
      data: {
        id: 'singleton',
        mode: 'disabled',
        clientId: 'legacy',
        clientSecretEnc: encrypt('super-secret-client-secret', KEY),
        signingSecretEnc: encrypt(generateSecret(), KEY),
      },
    });

    const server = Fastify({ logger: false });
    await server.register(prismaPlugin, { prisma });
    await server.register(authConfigPlugin, {
      env: makeTestEnv({ CONFIG_ENCRYPTION_KEY: WRONG_KEY_B64, AUTH_STRICT_BOOT: true }),
    });
    created.push(server);

    expect(server.authConfig.current.mode).toBe('disabled');
    expect(server.authConfig.storedMode).toBe('disabled');
    // No degrade occurred, so there is no cause to attribute (#241). This was
    // `'secret_decrypt_failure'` while a disabled row still decrypted its
    // leftover columns. Either way enforced and stored agree, so sanitize()
    // reports forceDisabledReason: null.
    expect(server.authConfig.overrideCause).toBeNull();
    const row = await prisma.authConfig.findUnique({ where: { id: 'singleton' } });
    expect(row!.mode).toBe('disabled');
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

/**
 * The strict-boot guard's predicate, asserted directly.
 *
 * It carries an `@ai-warning` forbidding a re-narrowing to `=== 'oidc'`, and
 * since #241 that warning is no longer covered by ANY integration test above:
 * `toEffective()` gates decryption on the stored mode, so only a stored `oidc`
 * row can raise `AuthSecretDecryptError`, and only `oidc` can therefore reach
 * the guard at all. The `local` arm is unreachable-but-load-bearing — it is
 * what keeps the guard correct for a future mode that stores decryptable
 * secrets, which is precisely the shape of the #222 fail-open (an `=== 'oidc'`
 * guard let a stored `local` row degrade into an open, anonymous-ADMIN API
 * under the flag whose whole purpose is to refuse that).
 *
 * Reachability and correctness are separate properties, so they get separate
 * tests: the boots/refuses cases above pin the reachable wiring, and these pin
 * the predicate itself. `=== 'oidc'` passes every integration test in this file
 * and fails the first case below — which is exactly the gap this closes.
 */
describe('degradeWouldWidenAccess — the strict-boot predicate (#222/#241)', () => {
  it('is TRUE for a stored `local` row — the arm no integration test can reach', () => {
    expect(degradeWouldWidenAccess('local')).toBe(true);
  });

  it('is TRUE for a stored `oidc` row', () => {
    expect(degradeWouldWidenAccess('oidc')).toBe(true);
  });

  it('is FALSE for a stored `disabled` row — degrading it is not a downgrade (#136 F1)', () => {
    expect(degradeWouldWidenAccess('disabled')).toBe(false);
  });

  it('is FALSE for an unrecognised stored mode, matching the closed-by-default normalization', () => {
    // `mode` is a plain String column. An unrecognised value is ENFORCED as
    // `disabled` (normalizeStoredMode / toEffective), so degrading it to
    // `disabled` widens nothing and must not refuse boot — the predicate has to
    // agree with enforcement, not with the raw column text.
    expect(degradeWouldWidenAccess('OIDC')).toBe(false);
    expect(degradeWouldWidenAccess('Local')).toBe(false);
    expect(degradeWouldWidenAccess('')).toBe(false);
  });
});
