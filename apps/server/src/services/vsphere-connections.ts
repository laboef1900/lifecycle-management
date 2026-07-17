import type {
  VsphereConnectionCreate,
  VsphereConnectionResponse,
  VsphereConnectionStatus,
  VsphereConnectionUpdate,
  VsphereTlsMode,
} from '@lcm/shared';
import type { PrismaClient, VsphereConnection } from '@prisma/client';

import { decrypt, encrypt } from '../crypto/secret-box.js';
import { NotFoundError, UnprocessableError } from './errors.js';
import { translatePrismaError } from './prisma-errors.js';

/**
 * Thrown when a stored vCenter password cannot be decrypted — the key is missing,
 * wrong, rotated, or the ciphertext is corrupt.
 *
 * Named so callers can degrade precisely rather than catching everything. Mirrors
 * `AuthSecretDecryptError`.
 */
export class VsphereSecretDecryptError extends Error {
  constructor(
    readonly connectionId: string,
    options?: { cause?: unknown },
  ) {
    super(`vCenter connection ${connectionId}: stored password could not be decrypted`, options);
    this.name = 'VsphereSecretDecryptError';
  }
}

const connectionTaken = (name: string): UnprocessableError =>
  new UnprocessableError(
    'CONNECTION_NAME_TAKEN',
    `A vCenter connection named ${name} already exists`,
  );

/**
 * Manages vCenter connections and their encrypted credentials (#175, epic #172).
 *
 * @ai-warning Two rules here are load-bearing and easy to "tidy" away:
 *
 * 1. **The decrypted password is never cached and never returned.** It is
 *    decrypted at the moment of use and handed straight to the caller that needs
 *    it. `AuthConfig` caches its secrets because they sit on the hot path of every
 *    request; these are used by a background job every few minutes, so
 *    decrypt-on-use costs nothing and keeps plaintext out of the long-lived heap.
 *
 * 2. **A decrypt failure NEVER nulls `passwordEnc`.** That ciphertext may be the
 *    only copy of an externally-issued credential, and restoring the right
 *    `CONFIG_ENCRYPTION_KEY` recovers it. Wiping it to "clean up" destroys the one
 *    thing that makes recovery possible. Same rule, same reasoning, as
 *    `plugins/auth-config.ts`.
 */
export class VsphereConnectionsService {
  constructor(
    private readonly prisma: PrismaClient,
    /** null when CONFIG_ENCRYPTION_KEY is unset — every write then fails loudly. */
    private readonly key: Buffer | null,
  ) {}

  async list(tenantId: string): Promise<VsphereConnectionResponse[]> {
    const rows = await this.prisma.vsphereConnection.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => this.toResponse(r));
  }

  async getById(tenantId: string, id: string): Promise<VsphereConnectionResponse> {
    const row = await this.prisma.vsphereConnection.findFirst({ where: { id, tenantId } });
    if (!row) throw new NotFoundError('VsphereConnection', id);
    return this.toResponse(row);
  }

  async create(
    tenantId: string,
    input: VsphereConnectionCreate,
  ): Promise<VsphereConnectionResponse> {
    const passwordEnc = this.encryptPassword(input.password);
    try {
      const row = await this.prisma.vsphereConnection.create({
        data: {
          tenantId,
          name: input.name,
          hostname: input.hostname,
          username: input.username,
          passwordEnc,
          enabled: input.enabled,
        },
      });
      return this.toResponse(row);
    } catch (err) {
      translatePrismaError(err, { uniqueConstraint: connectionTaken(input.name) });
      throw err;
    }
  }

  /**
   * @ai-warning The caller MUST have verified the password before reaching here
   * when `input` touches trust material (`hostname`/`username`). The shared
   * contract requires the password to be present in that case, and the route
   * verifies it against the stored one — the schema alone cannot tell whether the
   * supplied password is *correct*, only that it was supplied.
   */
  async update(
    tenantId: string,
    id: string,
    input: VsphereConnectionUpdate,
  ): Promise<VsphereConnectionResponse> {
    const existing = await this.prisma.vsphereConnection.findFirst({ where: { id, tenantId } });
    if (!existing) throw new NotFoundError('VsphereConnection', id);

    const data: Record<string, unknown> = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.enabled !== undefined) data.enabled = input.enabled;
    if (input.username !== undefined) data.username = input.username;
    if (input.password !== undefined) data.passwordEnc = this.encryptPassword(input.password);

    // Re-pointing at a different host invalidates everything we learned about the
    // old one. Keeping the pin would trust the OLD vCenter's CA for the NEW host;
    // keeping instanceUuid would let the identity check pass against an instance
    // we have never actually spoken to. Both are reset so the operator must
    // re-establish trust deliberately.
    if (input.hostname !== undefined && input.hostname !== existing.hostname) {
      data.hostname = input.hostname;
      data.tlsMode = 'pinned';
      data.tlsPinnedCaPem = null;
      data.tlsPinnedSha256 = null;
      data.instanceUuid = null;
      data.apiVersion = null;
      data.status = 'never_connected';
      data.lastConnectedAt = null;
      data.lastError = null;
    }

    try {
      const row = await this.prisma.vsphereConnection.update({ where: { id }, data });
      return this.toResponse(row);
    } catch (err) {
      translatePrismaError(err, { uniqueConstraint: connectionTaken(input.name ?? '') });
      throw err;
    }
  }

  async delete(tenantId: string, id: string): Promise<void> {
    const existing = await this.prisma.vsphereConnection.findFirst({ where: { id, tenantId } });
    if (!existing) throw new NotFoundError('VsphereConnection', id);
    await this.prisma.vsphereConnection.delete({ where: { id } });
  }

  /**
   * Pin a confirmed root as this connection's trust anchor.
   *
   * The fingerprint the admin confirmed is checked against the PEM the server is
   * about to store, so a mismatch between what was displayed and what gets pinned
   * is impossible.
   */
  async trustCa(
    tenantId: string,
    id: string,
    caPem: string,
    fingerprintSha256: string,
  ): Promise<VsphereConnectionResponse> {
    const existing = await this.prisma.vsphereConnection.findFirst({ where: { id, tenantId } });
    if (!existing) throw new NotFoundError('VsphereConnection', id);

    const row = await this.prisma.vsphereConnection.update({
      where: { id },
      data: {
        tlsMode: 'pinned',
        tlsPinnedCaPem: caPem,
        tlsPinnedSha256: fingerprintSha256.toUpperCase(),
        status: 'never_connected',
        lastError: null,
      },
    });
    return this.toResponse(row);
  }

  /**
   * The decrypted password, for the one caller that is about to use it.
   *
   * @ai-warning Never log, never cache, never return this to a client, and never
   * put it in an error message. It is returned as a bare string precisely so its
   * lifetime is obvious at the call site.
   */
  async revealPassword(tenantId: string, id: string): Promise<string> {
    const row = await this.prisma.vsphereConnection.findFirst({ where: { id, tenantId } });
    if (!row) throw new NotFoundError('VsphereConnection', id);
    return this.decryptPassword(row);
  }

  /**
   * Does `candidate` match the stored password?
   *
   * This is what makes the contract's "changing trust material requires the
   * password" rule real: the schema can only require that *a* password was sent,
   * not that it was the right one. Without this check the gate is decorative — an
   * anonymous caller in `disabled` mode would repoint a connection by sending any
   * string at all.
   *
   * A connection whose secret cannot be decrypted fails the check rather than
   * throwing: the caller is an attacker as often as an admin, and "wrong password"
   * is the honest answer to both.
   */
  async passwordMatches(tenantId: string, id: string, candidate: string): Promise<boolean> {
    const row = await this.prisma.vsphereConnection.findFirst({ where: { id, tenantId } });
    if (!row) throw new NotFoundError('VsphereConnection', id);
    try {
      return this.decryptPassword(row) === candidate;
    } catch {
      return false;
    }
  }

  /**
   * Record the outcome of a connection attempt.
   *
   * @ai-warning Degrade is PER-CONNECTION. One vCenter being unreachable, having a
   * rotated cert, or holding an undecryptable secret must never disable the
   * others — which is exactly what a global `mode=disabled` analogue (the
   * AuthConfig pattern) would do.
   */
  async recordStatus(
    id: string,
    status: VsphereConnectionStatus,
    opts: { error?: string | null; instanceUuid?: string; apiVersion?: string } = {},
  ): Promise<void> {
    await this.prisma.vsphereConnection.update({
      where: { id },
      data: {
        status,
        lastError: opts.error ?? null,
        ...(status === 'active' ? { lastConnectedAt: new Date() } : {}),
        ...(opts.instanceUuid !== undefined ? { instanceUuid: opts.instanceUuid } : {}),
        ...(opts.apiVersion !== undefined ? { apiVersion: opts.apiVersion } : {}),
      },
    });
  }

  private encryptPassword(plaintext: string): string {
    if (!this.key) {
      // Fail loudly rather than storing a credential in the clear, or silently
      // dropping it and leaving a connection that can never authenticate.
      throw new UnprocessableError(
        'ENCRYPTION_KEY_MISSING',
        'CONFIG_ENCRYPTION_KEY is not configured, so vCenter credentials cannot be stored',
      );
    }
    return encrypt(plaintext, this.key);
  }

  private decryptPassword(row: VsphereConnection): string {
    if (!this.key) throw new VsphereSecretDecryptError(row.id);
    try {
      return decrypt(row.passwordEnc, this.key);
    } catch (err) {
      throw new VsphereSecretDecryptError(row.id, { cause: err });
    }
  }

  /**
   * @ai-warning The response has no password field — not even redacted. The
   * encrypted secret never leaves the server, and a `password: '••••'` field is
   * the first step towards someone rendering the real one.
   */
  private toResponse(row: VsphereConnection): VsphereConnectionResponse {
    return {
      id: row.id,
      name: row.name,
      hostname: row.hostname,
      username: row.username,
      tlsMode: (row.tlsMode === 'system' ? 'system' : 'pinned') satisfies VsphereTlsMode,
      pinnedRootFingerprintSha256: row.tlsPinnedSha256,
      instanceUuid: row.instanceUuid,
      apiVersion: row.apiVersion,
      enabled: row.enabled,
      status: row.status as VsphereConnectionStatus,
      lastError: row.lastError,
      lastConnectedAt: row.lastConnectedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
