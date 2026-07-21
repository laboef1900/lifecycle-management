import type {
  VsphereConnectionCreate,
  VsphereConnectionResponse,
  VsphereConnectionStatus,
  VsphereConnectionUpdate,
  VsphereSyncOutcome,
  VsphereTlsMode,
} from '@lcm/shared';
import type { PrismaClient, VsphereConnection, VsphereConnectionJob } from '@prisma/client';

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
 * The `dueAt` a freshly seeded scheduler job gets. "Now" makes it immediately due
 * without letting newly-created rows jump ahead of every already-queued job as the
 * Unix epoch did. FIFO ordering is part of the anonymous-create work budget: a
 * steady stream of new rows must not perpetually starve an older first contact.
 */
const seedDueAt = (): Date => new Date();

/** A connection row with its scheduler job eagerly loaded, as `toResponse` needs it. */
type ConnectionWithJob = VsphereConnection & { job: VsphereConnectionJob | null };

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
      include: { job: true },
    });
    return rows.map((r) => this.toResponse(r));
  }

  async getById(tenantId: string, id: string): Promise<VsphereConnectionResponse> {
    const row = await this.prisma.vsphereConnection.findFirst({
      where: { id, tenantId },
      include: { job: true },
    });
    if (!row) throw new NotFoundError('VsphereConnection', id);
    return this.toResponse(row);
  }

  async create(
    tenantId: string,
    input: VsphereConnectionCreate,
  ): Promise<VsphereConnectionResponse> {
    const passwordEnc = this.encryptPassword(input.password);
    try {
      // Seed the scheduler job in the same write (#191). `connectionId` is the job's
      // PK+FK, so the nested create is atomic — a connection can never exist without
      // its job row, and the first tick imports immediately (`dueAt` is now).
      // Seeded even when `enabled: false`; the scheduler filters disabled
      // connections out, so an unused row is harmless and enabling later just bumps
      // `dueAt`.
      const row = await this.prisma.vsphereConnection.create({
        data: {
          tenantId,
          name: input.name,
          hostname: input.hostname,
          port: input.port,
          username: input.username,
          passwordEnc,
          enabled: input.enabled,
          job: { create: { dueAt: seedDueAt() } },
        },
        include: { job: true },
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
    // A port change repoints the socket on the SAME host, so — unlike a hostname
    // change below — it does NOT reset the pin: same host means the same Machine SSL
    // certificate, and the instanceUuid guard still catches "a different vCenter".
    // It is trust material for the PASSWORD gate (route-enforced), not for the pin.
    if (input.port !== undefined) data.port = input.port;

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

    // Enabling a previously disabled connection re-arms its scheduler job so the
    // next tick imports immediately (#191, D22: "sync-on-...enable"). Upsert, not
    // create: the row normally already exists (seeded at create); the upsert also
    // self-heals a connection that somehow lost its job. Disabling touches no job
    // row — the scheduler filters disabled connections out, and keeping the row
    // preserves its last-run history for the settings panel.
    const reEnabling = input.enabled === true && !existing.enabled;
    const rearmDueAt = seedDueAt();

    try {
      const updateConnection = this.prisma.vsphereConnection.update({
        where: { id },
        data,
        include: { job: true },
      });
      // Atomic: the enable and the re-arm land together, or neither does. `dueAt` is
      // not part of `syncState`, so the connection row's eagerly-loaded job is
      // accurate for the response even though the upsert bumps `dueAt` alongside.
      const row = reEnabling
        ? (
            await this.prisma.$transaction([
              updateConnection,
              this.prisma.vsphereConnectionJob.upsert({
                where: { connectionId: id },
                create: { connectionId: id, dueAt: rearmDueAt },
                update: { dueAt: rearmDueAt },
              }),
            ])
          )[0]
        : await updateConnection;
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
   * Queue an immediate sync for one connection — the admin **"Sync now"** action
   * (#192, design §D22). Sets the scheduler job's `dueAt = now()` and returns; it
   * performs NO vCenter I/O. The scheduler's next tick claims the row and runs it
   * through the **identical** claim/run path as a scheduled job — so "Sync now"
   * cannot drift from the scheduled behaviour, and it inherits the claim lock for
   * free (a double-click, or a trigger during a live run, cannot double-run).
   *
   * @ai-warning Resolve the connection **tenant-scoped first**. A bare upsert off
   * the `:id` path param would queue a sync for another tenant's connection — the
   * job row carries no `tenantId` of its own, only the transitive FK — and would
   * surface a raw FK violation rather than a 404 on an unknown id.
   *
   * @ai-warning The upsert's `update` touches ONLY `dueAt`. It must never clear
   * `runningSince`/`lockedBy`: doing so during a live run would strip the running
   * job of its claim and let a second worker re-run it. Pulling `dueAt` forward is
   * enough — the claim lock absorbs a concurrent trigger, and a run already in
   * flight means a sync just ran.
   *
   * A **disabled** connection is refused (422): the scheduler filters disabled
   * connections out, so queuing one would be a request that can never fire — a
   * silent lie, not a benign no-op.
   */
  async requestSyncNow(tenantId: string, id: string): Promise<{ dueAt: Date }> {
    const connection = await this.prisma.vsphereConnection.findFirst({
      where: { id, tenantId },
      select: { enabled: true },
    });
    if (!connection) throw new NotFoundError('VsphereConnection', id);
    if (!connection.enabled) {
      throw new UnprocessableError('CONNECTION_DISABLED', 'Enable the connection before syncing.');
    }

    const dueAt = new Date();
    // Upsert, not update: the job row normally exists (seeded on create/enable),
    // but creating it here keeps "Sync now" robust to provisioning order.
    await this.prisma.vsphereConnectionJob.upsert({
      where: { connectionId: id },
      create: { connectionId: id, dueAt },
      update: { dueAt },
    });
    return { dueAt };
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
    // Defense-in-depth at the storage boundary (#272): never persist an empty pin.
    // The caller always supplies a server-computed root PEM from a fresh re-probe,
    // so this cannot fire today — but a `tlsPinnedCaPem: ''` would silently disable
    // pinning (an empty `ca:` list falls back to the system store), so refuse it
    // here rather than trust the upstream gate to be the only safeguard. A bare
    // Error (→ sanitized 500) is intentional: this is an unreachable-invariant
    // assertion, not a user-input error, so it must not read as an expected 4xx.
    if (caPem.trim() === '') {
      throw new Error('refusing to pin an empty CA certificate');
    }

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
      include: { job: true },
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
  private toResponse(row: ConnectionWithJob): VsphereConnectionResponse {
    return {
      id: row.id,
      name: row.name,
      hostname: row.hostname,
      port: row.port,
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
      // The scheduler job's last-run outcome (#202 contract, populated by #191's
      // status writer). `null` = no job row yet; the object otherwise. Distinct from
      // `lastError`/`lastConnectedAt` above, which are connection reachability, not
      // job outcome.
      syncState: syncStateOf(row.job),
    };
  }
}

/**
 * Map a scheduler job row to the `syncState` sub-object of the response contract
 * (#202). `lastSyncStatus` is stored as an untyped `String?`; the values are only
 * ever written by the scheduler from the `VsphereSyncOutcome` vocabulary, and the
 * shared `vsphereSyncOutcomeSchema` validates it at the serialization boundary.
 */
function syncStateOf(
  job: VsphereConnectionJob | null,
): NonNullable<VsphereConnectionResponse['syncState']> | null {
  if (!job) return null;
  return {
    lastSyncAt: job.lastSyncAt?.toISOString() ?? null,
    lastSyncStatus: (job.lastSyncStatus as VsphereSyncOutcome | null) ?? null,
    lastSnapshotAt: job.lastSnapshotAt?.toISOString() ?? null,
    lastSnapshotStatus: job.lastSnapshotStatus,
    lastSuccessPeriod: job.lastSuccessPeriod ? isoDateOnly(job.lastSuccessPeriod) : null,
    failureCount: job.failureCount,
  };
}

/** A `@db.Date` column rendered as a date-only `YYYY-MM-DD` string. */
function isoDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}
