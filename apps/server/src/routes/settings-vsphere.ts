import {
  vsphereConnectionCreateSchema,
  vsphereConnectionIdParamsSchema,
  vsphereConnectionUpdateSchema,
  vsphereProbeSchema,
  vsphereTrustCaSchema,
  vsphereVerifySchema,
} from '@lcm/shared';
import type {
  VsphereConnectionResponse,
  VsphereProbeResult,
  VsphereSyncNowResponse,
  VsphereVerifyResult,
} from '@lcm/shared';
import type { FastifyPluginAsync } from 'fastify';

import { ForbiddenError, UnprocessableError } from '../services/errors.js';
import { verifyLogin } from '../services/vsphere-client.js';
import { VsphereConnectionsService } from '../services/vsphere-connections.js';
import { isDeniedTarget } from '../services/vsphere-guard.js';
import { probeCertificate } from '../services/vsphere-tls.js';

/**
 * `/api/settings/vsphere` — vCenter connections (#175, epic #172).
 *
 * @ai-warning The rule every route here enforces:
 *
 *   **Stored credentials may only be sent to a destination whose trust material
 *   was written by someone who knew the password.**
 *
 * In `AUTH_MODE=disabled` — the default, and what production runs — every
 * anonymous caller is an ADMIN principal, so the only asymmetry between the real
 * admin and an attacker is knowledge of the vCenter password. That is why the
 * password gate below is not belt-and-braces on top of the role check: **it IS
 * the control.**
 *
 * @ai-warning Do NOT add a "test the saved connection" route that accepts a URL,
 * nor let any route fall back to the stored password when one is omitted. That is
 * `routes/settings-auth.ts`'s shape, which is safe only because OIDC discovery
 * transmits no secret. vim25 `Login` does.
 */
export interface SettingsVsphereRoutesOptions {
  /**
   * The AES-GCM key for `secret-box`, derived from CONFIG_ENCRYPTION_KEY in
   * `buildServer` — server-side deployment config, never a request field. null
   * when unset, in which case storing a credential fails loudly rather than
   * silently writing one in the clear.
   */
  configKey: Buffer | null;
}

export const settingsVsphereRoutes: FastifyPluginAsync<SettingsVsphereRoutesOptions> = async (
  fastify,
  opts,
) => {
  const service = new VsphereConnectionsService(fastify.prisma, opts.configKey);

  // Tighter per-IP budget on every endpoint that can directly open an outbound
  // socket OR enqueue/re-arm background work against a stored caller-selected
  // host:port (#199 design C5). Creation is intentionally included: it seeds an
  // immediately-due scheduler job, so omitting it would let an anonymous caller in
  // `disabled` mode bypass the probe/verify limit through persistent background
  // retries. Inert in ordinary tests (the rate-limit plugin is not registered
  // there — see server.ts), exactly like the auth routes' limit.
  const outboundWorkRateLimit = { rateLimit: { max: 10, timeWindow: '1 minute' } };

  /**
   * Bootstrap-safe admin gate, mirroring `settings-auth.ts`. Open while auth is
   * disabled (there are no accounts to authenticate against, and this panel is how
   * an operator configures the system in the first place); admin-only once
   * local/oidc is on.
   *
   * This is defensible ONLY because the password gate removes the critical
   * primitive. On its own it would leave the credential path open to anyone who
   * can reach the API.
   */
  fastify.addHook('preHandler', async (request) => {
    if (fastify.authConfig.current.mode === 'disabled') return;
    if (request.user?.role !== 'ADMIN') {
      throw new ForbiddenError('Admin role is required to manage vCenter connections.');
    }
  });

  fastify.get(
    '/settings/vsphere/connections',
    async (request): Promise<VsphereConnectionResponse[]> => {
      return service.list(request.tenantId);
    },
  );

  fastify.post(
    '/settings/vsphere/connections',
    { config: outboundWorkRateLimit },
    async (request, reply) => {
      const body = vsphereConnectionCreateSchema.parse(request.body);
      guardTarget(body.hostname);
      const created = await service.create(request.tenantId, body);
      return reply.code(201).send(created);
    },
  );

  fastify.put(
    '/settings/vsphere/connections/:id',
    { config: outboundWorkRateLimit },
    async (request): Promise<VsphereConnectionResponse> => {
      const { id } = vsphereConnectionIdParamsSchema.parse(request.params);
      const body = vsphereConnectionUpdateSchema.parse(request.body);

      // The schema requires that A password accompany a trust-material change; only
      // the server can tell whether it is the RIGHT one. Without this check the gate
      // is decorative — an anonymous caller would repoint a connection by sending
      // any string at all, then wait for the next poll to deliver the credential.
      const touchesTrustMaterial =
        body.hostname !== undefined || body.port !== undefined || body.username !== undefined;
      if (touchesTrustMaterial) {
        if (!body.password) {
          throw new UnprocessableError(
            'PASSWORD_REQUIRED',
            'Changing the hostname, port, or username requires re-entering the password',
          );
        }
        const ok = await service.passwordMatches(request.tenantId, id, body.password);
        if (!ok) {
          throw new UnprocessableError(
            'PASSWORD_MISMATCH',
            'The password does not match this connection',
          );
        }
      }
      if (body.hostname !== undefined) guardTarget(body.hostname);

      return service.update(request.tenantId, id, body);
    },
  );

  fastify.delete('/settings/vsphere/connections/:id', async (request, reply) => {
    const { id } = vsphereConnectionIdParamsSchema.parse(request.params);
    await service.delete(request.tenantId, id);
    return reply.code(204).send();
  });

  /**
   * "Sync now" (#192, design §D22): queue an immediate sync for one connection.
   *
   * Sets the connection's scheduler job `dueAt = now()` and returns **202 at once**
   * — it NEVER awaits vCenter (a request handler must not; see D25). The scheduler's
   * next tick claims the row and runs it through the identical claim/run path as a
   * scheduled job, so this cannot become a second, drifting code path, and the
   * claim lock makes a double-click structurally unable to double-run.
   *
   * Admin-gated by the preHandler above (and the global `requiresAdmin` mutation
   * hook). **No password required**, unlike the trust-material routes: this mutates
   * no trust material and discloses nothing, so a password gate here would be
   * friction on a benign action, not the control — see the file header.
   */
  fastify.post(
    '/settings/vsphere/connections/:id/sync',
    { config: outboundWorkRateLimit },
    async (request, reply) => {
      const { id } = vsphereConnectionIdParamsSchema.parse(request.params);
      const { dueAt } = await service.requestSyncNow(request.tenantId, id);
      const body: VsphereSyncNowResponse = { dueAt: dueAt.toISOString() };
      return reply.code(202).send(body);
    },
  );

  /**
   * PHASE 1 — reachability + certificate capture. **Sends no credential**, and the
   * schema carries none, so it cannot forward one even by mistake.
   */
  fastify.post(
    '/settings/vsphere/probe',
    { config: outboundWorkRateLimit },
    async (request): Promise<VsphereProbeResult> => {
      const body = vsphereProbeSchema.parse(request.body);
      guardTarget(body.hostname);

      const result = await probeCertificate(body.hostname, body.port);
      // Server-log only (#272): the chain shape never leaves the server (the
      // response below carries only a fingerprint), but `terminalSelfSigned:
      // false` on an `ok` probe is the incomplete-chain signal — the operator is
      // about to pin a non-root anchor whose credentialed handshake will fail.
      // `diagnostics` carries subject/issuer CNs, so it stays out of the response.
      request.log.info(
        { event: 'vsphere.probe', outcome: result.outcome, ...(result.diagnostics ?? {}) },
        result.outcome === 'ok' ? 'vCenter probe captured chain' : 'vCenter probe failed',
      );
      if (result.outcome !== 'ok' || !result.chain) {
        return {
          reachable: false,
          trustedBySystemRoots: false,
          rootFingerprintSha256: null,
          validFrom: null,
          validTo: null,
          outcome: result.outcome === 'unreachable' ? 'unreachable' : 'tls_untrusted',
        };
      }

      // Only the fingerprint and validity leave the server — never subject, issuer,
      // or SANs. A fingerprint is a hash: useless for enumerating a network, and
      // exactly what an admin compares against `govc about.cert -thumbprint`.
      return {
        reachable: true,
        trustedBySystemRoots: result.chain.trustedBySystemRoots,
        rootFingerprintSha256: result.chain.rootFingerprintSha256,
        validFrom: result.chain.validFrom,
        validTo: result.chain.validTo,
        outcome: 'ok',
      };
    },
  );

  /**
   * PHASE 2 — verify the credential logs in. The password comes from the request
   * body and is **required by the contract with no stored fallback**.
   */
  fastify.post(
    '/settings/vsphere/verify',
    { config: outboundWorkRateLimit },
    async (request): Promise<VsphereVerifyResult> => {
      const body = vsphereVerifySchema.parse(request.body);
      guardTarget(body.hostname);

      // No pinned root is available for an unsaved connection, so this verifies
      // against the system trust store. A self-signed vCenter therefore reports
      // `tls_untrusted` until its CA is confirmed and pinned — which is the intended
      // order: vet the certificate, THEN send the credential.
      const result = await verifyLogin({
        hostname: body.hostname,
        port: body.port,
        username: body.username,
        password: body.password,
        pinnedRootPem: null,
      });

      // @ai-warning The log line carries the OUTCOME only. Never the password, never
      // the raw error — `authorization`/`cookie` redaction does not cover a body we
      // log ourselves.
      request.log.info({ event: 'vsphere.verify', outcome: result.outcome }, 'vCenter verify');

      return {
        outcome: result.outcome,
        instanceUuid: result.about?.instanceUuid ?? null,
        apiVersion: result.about?.apiVersion ?? null,
      };
    },
  );

  /**
   * Pin a confirmed CA root. Requires the password: this mutates trust material,
   * and a re-pin plus a DNS spoof delivers the credential on the next poll.
   */
  fastify.post(
    '/settings/vsphere/connections/:id/trust-ca',
    { config: outboundWorkRateLimit },
    async (request): Promise<VsphereConnectionResponse> => {
      const { id } = vsphereConnectionIdParamsSchema.parse(request.params);
      const body = vsphereTrustCaSchema.parse(request.body);

      const ok = await service.passwordMatches(request.tenantId, id, body.password);
      if (!ok) {
        throw new UnprocessableError(
          'PASSWORD_MISMATCH',
          'The password does not match this connection',
        );
      }

      const connection = await service.getById(request.tenantId, id);
      // Re-probe rather than trusting a client-supplied PEM: the server pins what IT
      // observes, and the admin's fingerprint only has to agree. A client-supplied
      // certificate would let a caller pin an anchor the server never saw.
      const probe = await probeCertificate(connection.hostname, connection.port);
      // Server-log only (#272): capture the chain shape at the exact moment trust
      // is being granted. A `terminalSelfSigned: false` here means the pin about
      // to be stored is an incomplete-chain leaf/intermediate — trust "succeeds"
      // now and every scheduled sync then fails, which is the reported symptom.
      request.log.info(
        {
          event: 'vsphere.trust',
          connectionId: id,
          outcome: probe.outcome,
          ...(probe.diagnostics ?? {}),
        },
        'vCenter trust re-probe',
      );
      if (probe.outcome !== 'ok' || !probe.chain) {
        throw new UnprocessableError(
          'VCENTER_UNREACHABLE',
          'Could not reach vCenter to read its certificate',
        );
      }
      if (probe.chain.rootFingerprintSha256 !== body.rootFingerprintSha256.toUpperCase()) {
        // The presented certificate is not the one the admin confirmed. Fail rather
        // than pin: this is either a rotation the admin has not seen, or an attack.
        throw new UnprocessableError(
          'FINGERPRINT_MISMATCH',
          'The certificate presented does not match the fingerprint you confirmed',
        );
      }

      return service.trustCa(
        request.tenantId,
        id,
        probe.chain.rootPem,
        probe.chain.rootFingerprintSha256,
      );
    },
  );
};

/**
 * Reject targets that are never a legitimate vCenter.
 *
 * @ai-warning This is the INVERSE of `oidc.ts`'s deny-list, deliberately. A
 * vCenter is private by definition, so RFC1918/ULA/CGNAT addresses are EXPLICITLY
 * PERMITTED here — re-adding them (to "match" the OIDC guard) would break every
 * legitimate deployment. Only loopback, unspecified, and link-local/metadata are
 * denied.
 *
 * Honest about its value: it is low. The database is a separate container at a
 * private address indistinguishable from a vCenter, so this CANNOT protect it.
 * It is a cheap hedge against deployment drift, not the control doing the work —
 * that is the password gate.
 */
function guardTarget(hostname: string): void {
  if (isDeniedTarget(hostname)) {
    throw new UnprocessableError(
      'TARGET_NOT_ALLOWED',
      'That address cannot be a vCenter (loopback, unspecified, or link-local)',
    );
  }
}
