# Design note — issue #222: `RECOVERY_DISABLE_AUTH` must not persist `mode=disabled`

**Date:** 2026-07-18 · **Risk:** HIGH (CLAUDE.md — touches `plugins/auth*`, `routes/settings-auth.ts`, and the `@lcm/shared` auth contract) · **Status:** awaiting project-owner approval. No code is to be written before sign-off.

---

## 1. Problem

`RECOVERY_DISABLE_AUTH=true` is documented as a boot-scoped break-glass override. It is implemented as a **permanent database mutation**.

```ts
// apps/server/src/plugins/auth-config.ts:172-193
if (env.RECOVERY_DISABLE_AUTH) {
  fastify.log.warn(
    'RECOVERY_DISABLE_AUTH=true: forcing AuthConfig mode=disabled (break-glass override). ...',
  );
  await fastify.prisma.authConfig.update({
    // :177-180  ← the bug
    where: { id: SINGLETON_ID },
    data: { mode: 'disabled' },
  });
  current =
    key !== null && !decryptFailed ? await service.load(env) : { ...current, mode: 'disabled' }; // :191-192
}
```

The stored `auth_config.mode` (`prisma/schema.prisma:433`, `mode String @default("disabled")`) is overwritten. `service.load()` maps that column straight through (`services/auth-config.ts:278`), so the _next_ boot — flag cleared — loads `disabled` and `plugins/auth.ts:114` short-circuits authentication for every request. The deployment runs an open API and nothing in the UI says so.

Every operator-facing surface promises the opposite:

| Surface                           | Claim                                                                         | Verdict                               |
| --------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------- |
| `docs/operations.md:591-594`      | "set `RECOVERY_DISABLE_AUTH=false` … to resume normal operation"              | **FALSE**                             |
| `docs/operations.md:695`          | same sentence, local-accounts recovery                                        | **FALSE**                             |
| `docs/operations.md:605-606`      | "Configure authentication (or clear the break-glass flag) promptly"           | **FALSE**                             |
| `docs/operations.md:587-589`      | "On that boot … regardless of what's stored in the DB"                        | literally true, materially misleading |
| `README.md:113`                   | "forces auth off on next boot regardless of stored config"                    | misleading ("next boot" ⇒ one boot)   |
| `.env.example:59-63`              | "Set back to `false` … once access is restored"                               | **FALSE**                             |
| `docker/docker-compose.yml:76-77` | "forces auth disabled on next boot"                                           | misleading                            |
| `CLAUDE.md:193`                   | "degrade with a clear log line, never take the app down or **destroy state**" | code violates its own rule            |
| `docker/README.md:170-172`        | pure cross-reference                                                          | no change needed                      |

### Original design intent — verified verdict: **deliberate, and it conflicts with a later spec**

Not a slip. `docs/superpowers/specs/2026-07-03-oidc-settings-ui-design.md:180-186` specifies it verbatim: _"the `auth-config` plugin forces the row's `mode` to `disabled` **(persisted**, logged at `warn`…)"_. The plan repeats the instruction with the exact Prisma call (`docs/superpowers/plans/2026-07-03-oidc-settings-ui.md:456`), and commit `26bf0ca` implements it literally. Three integration assertions pin it (`__tests__/auth-config-plugin.test.ts:156, :179, :203`).

The recorded recovery in that spec is _"The operator regains UI access, **fixes the config**, unsets the flag, and restarts"_ — the "fixes the config" step is load-bearing (it must re-select a non-`disabled` mode) but was never given an acceptance criterion or a test.

Three days later, `docs/superpowers/specs/2026-07-06-local-admin-auth-design.md:227-229` wrote a recovery procedure that **drops that step**: _"the operator resets the password/creates an admin in Settings, then restarts."_ Resetting a password never touches `auth_config.mode`. That spec shipped verbatim into `docs/operations.md:695`. So this is a **spec-vs-spec conflict**, and the local-mode path is a complete, correctly-followed procedure that provably leaves the API open.

### Second, independent instance of the same defect

The `CONFIG_ENCRYPTION_KEY` decrypt-failure guard persists `mode='disabled'` too:

```ts
// apps/server/src/plugins/auth-config.ts:150-153
const row = await fastify.prisma.authConfig.update({
  where: { id: SINGLETON_ID },
  data: { mode: 'disabled' },
});
```

This makes `docs/operations.md:562-567` ("restoring the correct key … recovers the configuration exactly as it was") and `:575-579` ("roll `CONFIG_ENCRYPTION_KEY` back … without re-entering anything") false as well. It also fires **on the same boot** as break-glass whenever the key is missing/wrong — which is exactly why `auth-config-plugin.test.ts:135` and `:208` (both `RECOVERY_DISABLE_AUTH: true`) assert a persisted `disabled` row today. **Fixing only the break-glass branch leaves #222 unfixed in 2 of 4 break-glass scenarios.** This note therefore puts both branches in scope; see §4 for why splitting them is worse.

---

## 2. Impact / threat model

**Trust boundary.** In production only `web` publishes a host port (`docker/docker-compose.yml:131-132`, no `127.0.0.1:` prefix ⇒ Docker binds `0.0.0.0`), and nginx proxies the whole API (`docker/nginx.conf:35-36`). Reachable from anything that can route to the Docker host on `HTTP_PORT`. CORS is off by default and is **not** a mitigation — it constrains browsers, not `curl`.

**What `mode=disabled` actually means.** Not "lenient auth". `plugins/auth.ts:113-117` assigns every request `ANONYMOUS_USER` with `role: 'ADMIN'` (`plugins/auth.ts:56-62`). The RBAC hook still runs but checks `request.user.role`, which was just set to ADMIN — the code says so itself at `plugins/auth.ts:33-34, 139-140`. **There is no residual protection behind the auth mode.**

**Reachable by an unauthenticated caller on the network:**

| Surface                                                                       | Evidence                                                                                                                                                      | Impact                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entire `/api` (clusters, hosts, items, categories, forecast, settings)        | `server.ts:93-128`, all under `/api`; auth hook returns early                                                                                                 | Full read **and write** of capacity data. Forecasts drive hardware purchasing (CLAUDE.md), so this is integrity, not just confidentiality.                                                                                                                                                               |
| `GET /api/settings/auth`                                                      | `routes/settings-auth.ts:78-83` early-returns when disabled; `:93-95` → `services/auth-config.ts:296-321`                                                     | Discloses `issuerUrl`, `clientId`, `roleClaim`, `adminValues`, `allowedEmails`/`Domains`. Secrets correctly reduced to booleans (`:315-316`). E-mail allowlists are sensitive data under CLAUDE.md; `adminValues` names the claim value that grants admin.                                               |
| `PUT /api/settings/auth`                                                      | `routes/settings-auth.ts:97-152`; persists at `:147` with `request.user?.id` = the literal string `'anonymous'`                                               | **Deployment takeover.** Point the deployment at an attacker-run IdP, enable OIDC, become the only legitimate admin. The server-side discovery re-test (`:125-137`) is no barrier — an attacker's issuer passes its own discovery.                                                                       |
| `POST /api/settings/auth/local-users`, `…/:id/reset-password`, `DELETE …/:id` | `routes/settings-auth.ts:199-243`; last-admin guard requires `mode === 'local'` (`services/local-users.ts:209-215`) and is therefore **inert while disabled** | **Persistence primitive.** Plant an admin or reset an admin password to a known value; it survives after auth is correctly restored. Also: delete every admin ⇒ hard lockout.                                                                                                                            |
| `GET/DELETE /api/settings/vsphere/connections`, `POST …/:id/sync`             | `routes/settings-vsphere.ts:77-82, 84-89, 136-140, 156-165`; DTO at `packages/shared/src/schemas/vsphere.ts:252-270`                                          | Discloses vCenter hostnames, ports, service-account usernames, TLS fingerprints. Unauthenticated delete and unauthenticated outbound sync.                                                                                                                                                               |
| `POST /api/settings/vsphere/probe` / `verify`                                 | `routes/settings-vsphere.ts:171-242`, `guardTarget` at `:307-314`, deny-list **inverted** by design at `:293-306`                                             | Unauthenticated internal network scanner: RFC1918/ULA/CGNAT are _explicitly permitted_; only loopback/unspecified/link-local denied. Rate-limited 10/min/IP (`:65`). The code is candid that it cannot protect the DB container.                                                                         |
| `POST /api/settings/auth/test` (SSRF)                                         | deny-list at `plugins/oidc.ts:216-222`, classification `:69-102`                                                                                              | Blocks private/loopback/link-local **unless** `allowInternalIssuer` — which is `env.NODE_ENV !== 'production' \|\| env.OIDC_ALLOW_INSECURE` (`server.ts:109`). With `OIDC_ALLOW_INSECURE` set, full internal SSRF incl. `169.254.169.254`. Documented DNS-rebinding TOCTOU at `plugins/oidc.ts:167-175`. |

**Genuine mitigation to credit:** the vCenter _password_ is protected by a knowledge-factor gate, not a role gate (`routes/settings-vsphere.ts:23-41, 113-129, 255-261`) — the header says explicitly _"it IS the control"_. That is the correct pattern for any surface that must survive `disabled` mode.

**Detection today.** One pino line per boot, production only: `plugins/auth.ts:76-81` → `server.ts:86-88`. Nothing in the SPA: `/api/auth/me` returns bare `{authRequired: false}` (`routes/auth.ts:245-247`), the web app maps that to "everyone is admin" (`apps/web/src/lib/auth.ts:17`), and the app renders completely normally — no banner, no login prompt. So an operator who "recovers" sees an app that works, which is precisely the signal they expect for success.

**Misuse cases.**

1. Operator follows `operations.md:695` exactly → open API indefinitely.
2. Insider/attacker with brief network access during any break-glass window plants an admin account → retains access after auth is correctly restored. **The code fix does not remediate this**; §9 covers it.
3. Attacker repoints the IdP via unauthenticated `PUT /settings/auth` and locks the real operator out.

---

## 3. Chosen design — synthesis: **sticky in-memory override + truthful Settings response**

One funnel produces the override, the state object carries provenance, and the Settings API stops lying about what is stored.

### 3.1 `AuthConfigState` gains provenance (`plugins/auth-config.ts:18-22`)

```ts
export interface AuthConfigState {
  /** As ENFORCED — the override applied. Every auth gate reads this. */
  current: EffectiveAuthConfig;
  /** As STORED in auth_config.mode, unmasked. Presentation + guards read this. */
  storedMode: EffectiveAuthConfig['mode'];
  /** env.RECOVERY_DISABLE_AUTH, captured once at registration. Immutable. */
  readonly breakGlass: boolean;
  service: AuthConfigService;
  reload(): Promise<void>;
}
```

Provenance lives on the _state_, not on `EffectiveAuthConfig` — it is a property of the running process, not of the configuration. Putting it on `EffectiveAuthConfig` (14 flat fields, `services/auth-config.ts:62-77`) would force edits to `toEffective()` and both hand-built literals for no gain.

### 3.2 One override funnel

Inserted after `plugins/auth-config.ts:91`:

```ts
const breakGlass = env.RECOVERY_DISABLE_AUTH; // parsed boolean, env.ts:58-64

/**
 * The ONLY producer of the break-glass override. In-memory only: auth_config
 * is never written by it, so clearing the env var and restarting resumes the
 * configured mode (issue #222).
 * @ai-warning Every value assigned to `state.current` must come from here.
 */
const enforce = (loaded: EffectiveAuthConfig): EffectiveAuthConfig =>
  breakGlass ? { ...loaded, mode: 'disabled' } : loaded;
```

`{ ...loaded, mode: 'disabled' }` is structurally valid under `exactOptionalPropertyTypes` — `EffectiveAuthConfig` has no optional properties, and the identical spread already exists at `auth-config.ts:192`.

### 3.3 Deletions

- `auth-config.ts:177-180` — the break-glass `prisma.authConfig.update`. **This is #222.**
- `auth-config.ts:150-153` — the decrypt-failure `prisma.authConfig.update` (see §3.5).
- `auth-config.ts:191-192` — the ternary. **This is the landmine:** deleting only the DB write while keeping `await service.load(env)` here re-reads the stored `oidc` and turns break-glass into a _silent no-op_, locking the operator out during an emergency. The whole `if (env.RECOVERY_DISABLE_AUTH)` block collapses to a log line.
- `auth-config.ts:94-98, :110` — `decryptFailed`, dead once `:192` is gone. `key` (`:90`) stays; the service constructor needs it.

### 3.4 Assignment sites — three, all funnelled, `storedMode` set alongside

```ts
// boot happy path (replaces :100)
const loaded = await service.load(env);
storedMode = loaded.mode;
current = enforce(loaded);

// state construction (replaces :195-201)
const state: AuthConfigState = {
  current,
  storedMode,
  breakGlass,
  service,
  async reload() {
    const next = await service.load(env);
    state.storedMode = next.mode; // MUST be state.*, not the closure let
    state.current = enforce(next);
  },
};
```

`state.storedMode` is assigned on the **state object** at every derivation site. A closure-only `let` would go stale after every `reload()` and — combined with §3.6 — would round-trip a stale mode back into the DB through the Settings form. That is a real fail-open path and the single most important implementation detail in this note.

### 3.5 Decrypt-failure branch (in scope)

Delete the write at `:150-153`; hand-build from the `storedRow` already fetched at `:116`:

```ts
if (storedRow === null) throw err; // unreachable in practice (load() creates the row
// at services/auth-config.ts:159); fail loud, don't guess
storedMode = storedRow.mode === 'oidc' ? 'oidc' : storedRow.mode === 'local' ? 'local' : 'disabled';
current = {
  mode: 'disabled' /* …fields from storedRow, clientSecret: null, signingSecret: null… */,
};
```

Three things this must get right, each of which a naive edit gets wrong:

1. `storedRow.mode` is `String` in Prisma (`schema.prisma:433`), **not** the union. It must be normalized through the same ternary `toEffective()` uses (`services/auth-config.ts:278`) or `tsc --noEmit` fails.
2. `current.mode` is hardcoded `'disabled'` here — it is **not** produced by `enforce()`. The decrypt degrade is a _second, distinct_ override with its own cause. Invariant 1 is worded accordingly; the "one funnel" claim is scoped to the break-glass override only.
3. `service.load()` is still never re-called on this path — `toEffective()` decrypts both secret columns unconditionally regardless of mode (`services/auth-config.ts:276-293`), so it would throw the same `AuthSecretDecryptError` outside the try/catch and crash boot. Preserved structurally by not calling it.

`clientSecret`/`signingSecret` stay `null` here: they genuinely could not be decrypted. Ciphertext columns are untouched, as today.

### 3.6 Settings API tells the truth (`@lcm/shared` change)

Without this, the fix is defeated through the front door. `sanitizedView()` serializes the **overridden** config (`routes/settings-auth.ts:85-91`); the web form defaults `mode` from that response (`apps/web/src/components/settings/authentication-form.tsx:84`) and **always** sends `mode` in the PUT (`:192` — `mode` is a required field of a `z.strictObject`, `packages/shared/src/schemas/auth-config.ts:7-8`); `service.update()` writes it unconditionally (`services/auth-config.ts:220`). So during break-glass the form would load `disabled`, echo `disabled`, and clobber the stored `oidc`.

Fix — these two ship together or not at all:

- `service.sanitize()` reports **`storedMode`**, not `current.mode`.
- `authConfigResponseSchema` (`packages/shared/src/schemas/auth-config.ts:54-72`) gains `breakGlassActive: boolean`.

Reporting the stored mode alone would show "OIDC enabled" over a wide-open API — strictly worse than today. The pair is the minimum coherent unit. It also removes the need for any server-side coercion or blanket rejection of a submitted `mode`: with a truthful response, the echo is the stored value, and an explicit `mode: 'disabled'` submission remains a legitimate, expressible operator choice.

**Split to state in a comment:** _enforcement_ reads `current.mode` (`plugins/auth.ts:114, :126`; `routes/settings-auth.ts:79`; `routes/settings-vsphere.ts:78`); _presentation and lockout guards_ read `storedMode` (`routes/settings-auth.ts:85-91, :225, :241`).

### 3.7 Last-admin guard keyed on the stored mode

`routes/settings-auth.ts:225` and `:241` pass `fastify.authConfig.current.mode` into `disableOrDemoteGuarded` / `removeGuarded`; the predicate requires `mode === 'local'` (`services/local-users.ts:209-215`), so during break-glass the guard is **off**. Today that is survivable because the row gets flipped to `disabled` anyway. Once the row is preserved as `local`, deleting the last admin during break-glass produces a **hard lockout** on the next clean boot: mode `local`, zero enabled admins, no anonymous access. Both call sites must pass `fastify.authConfig.storedMode`.

### 3.8 Divergence alarm

`authStartupWarnings` (`plugins/auth.ts:71-100`) returns `string[]`, all logged at `warn` (`server.ts:86-88`). Change it to take the state and return `{ level: 'warn' | 'error'; event: string; message: string }[]`, and add one entry:

- `current.mode === 'disabled' && storedMode !== 'disabled'` → **`level: 'error'`**, `event: 'auth_config.open_despite_configuration'`, **every `NODE_ENV`, ungated**.

Zero false positives by construction: enforced and stored disagree only under an override. It is a _state_ assertion, not a cause enumeration, so it also covers any future override mechanism. `server.ts:86` becomes `server.log[w.level]({ event: w.event }, w.message)`. Removing the DB write removes the only DB-visible trace that auth was force-disabled; this alarm plus the boot warn replace it. `enforce()` additionally logs `auth_config.break_glass_override_applied` at `warn` when it overrides — bounded volume (boot + rare operator-initiated reloads), unlike per-request logging.

### 3.9 `reload()` and mid-session handling — the load-bearing part

**The threat.** `reload()` (`auth-config.ts:198-200`) is an unconditional `state.current = await service.load(env)`. It is the _only_ production write to `state.current` — `grep -rn '\.current = ' apps/server/src` returns exactly `auth-config.ts:199` outside tests. Today it is harmless only because the row was flipped. Preserve the row and leave `reload()` alone, and the first reload resurrects `oidc`/`local` into `state.current`.

**Concrete exploit path.** `POST /api/settings/auth/rotate-signing-secret` (`routes/settings-auth.ts:172-179`) calls `reloadOrUnprocessable` at `:176`, but `rotateSigningSecret()` writes **only** `signingSecretEnc` (`services/auth-config.ts:268-272`) — `mode` is untouched. The row still says `oidc`, the reload reads `oidc`, and because the auth gate reads the live object per request (`plugins/auth.ts:114, :126`) the operator is locked out **on the very next request**, mid-recovery, with the break-glass flag still set. A restart would silently self-heal, giving them no way to reason about what happened. That endpoint is reachable during break-glass precisely because `routes/settings-auth.ts:78-83` opens the whole file when the mode is disabled.

**The handling.** The override is a pure function applied at every point where `current` is derived, not a one-time event. `reload()` calls `enforce()`. There is exactly one funnel, so "did I remember to re-apply it here?" is not a question a future contributor can get wrong.

**Why stickiness is genuinely process-lifetime.** `breakGlass` is captured in the plugin closure from an already-parsed boolean (`env.ts:58-64`), never re-read from `process.env`. The plugin registers exactly once (`server.ts:82`), `buildServer` has one production caller (`index.ts:10`), nothing re-decorates `authConfig`, and no timer or background job touches it (`plugins/vsphere-scheduler.ts` contains no `authConfig` reference). `state` identity is stable; only `state.current`/`state.storedMode` are reassigned, both through the funnel.

**Accepted consequence.** `PUT /api/settings/auth` during break-glass **persists** the operator's chosen mode but does **not** take effect in-session — auth stays disabled until the flag is cleared and the server restarts. This is the correct precedence (the deliberate flag wins) and it is now _visible_ rather than silent: the response reports the new `storedMode` with `breakGlassActive: true`, so the UI shows "OIDC — pending restart" instead of snapping back to "Disabled". `fastify.oidc.reconfigure()` (`routes/settings-auth.ts:149`) sees `current.mode !== 'oidc'` and parks discovery in the `disabled` state (`plugins/oidc.ts:326-333`) — correct, but it means `discoveryStatus` reads `disabled` beside a reported mode of `oidc`; the UI alert must explain that.

Two readers are boot-time snapshots taken _after_ `decorate()`, so they see the overridden value and are unaffected either way: `server.ts:86` and `plugins/oidc.ts:269`.

### 3.10 UI (`apps/web/src/components/settings/authentication-form.tsx`)

One inline alert above the mode selector when `data.breakGlassActive`: auth is force-disabled by `RECOVERY_DISABLE_AUTH`; the stored mode is `<storedMode>`; changes save but take effect only after clearing the flag and restarting. House style: `--warning` token, text + icon — colour is never the sole signal (CLAUDE.md).

---

## 4. Rejected alternatives

| Alternative                                                                      | Reason                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Delete the DB write, change nothing else**                                     | Break-glass becomes a silent no-op on the happy path (`auth-config.ts:191-192` re-reads the stored `oidc`), and any `reload()` re-locks the operator out mid-recovery via rotate-signing-secret. Converts a security bug into an emergency-recovery bug.                                                                                                                                                                                  |
| **Make `reload()` honour the override only for loads that did not set `mode`**   | Requires threading intent through `reload()` and reintroduces exactly the rotate-signing-secret hole through a narrower door. Harder to reason about, same failure.                                                                                                                                                                                                                                                                       |
| **Server-side coercion: rewrite a submitted `mode: 'disabled'` to `storedMode`** | Silently reinterprets operator input, and skips the `if (body.mode === 'oidc')` block at `routes/settings-auth.ts:101` — which is where the mandatory discovery re-test **and the only SSRF deny-list** (`plugins/oidc.ts:216`) live. It would persist an untested, deny-list-unchecked issuer, violating the file's own documented invariant (`routes/settings-auth.ts:57-59`) and CLAUDE.md Golden Rule 8.                              |
| **Blanket-reject `mode: 'disabled'` (or any mode change) during break-glass**    | `mode` is required in `authConfigUpdateSchema` (`packages/shared/src/schemas/auth-config.ts:8`), so this makes "turn auth off permanently" unexpressible, and blocks the documented create-local-admin-then-switch-to-`local` recovery. §3.6 solves the root cause instead.                                                                                                                                                               |
| **Split the decrypt-failure branch (`:150-153`) into a follow-up issue**         | It fires on the _same boot_ as break-glass whenever the key is broken, so #222 would remain unfixed in 2 of 4 scenarios, and `operations.md:591-594` would become _conditionally_ true — worse than uniformly false. Including it is also the smaller diff: one `update()` deleted, the literal re-sourced from a row already fetched at `:116`.                                                                                          |
| **Global UI banner + `AuthMeResponse` change**                                   | Gated on `mode === 'disabled'` it is a permanent banner on this app's documented default deployment mode (CLAUDE.md records `disabled` as an accepted risk) ⇒ banner blindness. Gated on `breakGlassActive` it misses the residual risk (already-damaged deployments whose stored mode genuinely is `disabled`). Both arms fail; the §3.8 boot alarm is read during incident review instead. Also avoids a second shared-contract change. |
| **Fail `/readyz`, or add `/api/health/auth`**                                    | Turns a posture concern into a restart loop behind any orchestrator — directly violates CLAUDE.md §3 Resilience. A new endpoint nothing scrapes is dead code (no metrics stack in v1).                                                                                                                                                                                                                                                    |
| **Make `AUTH_STRICT_BOOT` default on**                                           | Would brick exactly the pre-fix-damaged deployments this is meant to help: boot-loop with no UI to repair from, and the UI is the only repair tool. Strict boot is opt-in for that reason.                                                                                                                                                                                                                                                |
| **Restore the stored mode automatically after a break-glass episode**            | A security control that silently _re-enables_ auth is as unacceptable as one that silently disables it, and the server cannot know whether the stored OIDC config still resolves. Detection and notification only.                                                                                                                                                                                                                        |
| **Per-request / recurring break-glass logging**                                  | Unbounded volume on a hot path. Bounded version (boot + each reload) adopted instead.                                                                                                                                                                                                                                                                                                                                                     |

---

## 5. Invariants (numbered, each testable)

1. **`enforce()` is the sole producer of the break-glass override**, applied at every site where `state.current` is derived (boot load, `reload()`). The decrypt-failure degrade is a separate, explicitly-hardcoded override with its own cause — it is _not_ produced by `enforce()`. Test: reload-under-break-glass keeps `current.mode === 'disabled'`.
2. **Neither the break-glass override nor the decrypt degrade writes `auth_config.mode`.** Stated precisely because it is a trap: `service.load()` itself still writes on a break-glass boot — row creation (`services/auth-config.ts:159`), env seeding (`:154/:157`), signing-secret upgrade (`:183-186`). "A break-glass boot performs no DB write at all" is a **false** assertion and must not be written.
3. While `RECOVERY_DISABLE_AUTH` is set, `authConfig.current.mode === 'disabled'` holds for the **entire process lifetime** — after boot, after every `reload()`, after every Settings write.
4. `authConfig.storedMode` always equals `auth_config.mode` as of the most recent load, refreshed on **every** `reload()`, never masked.
5. `authConfig.breakGlass` is immutable for the process lifetime and derived solely from `env.RECOVERY_DISABLE_AUTH` at registration.
6. Clearing `RECOVERY_DISABLE_AUTH` and restarting restores the stored mode with **no operator action in Settings**. (Executable form of `operations.md:591-594` / `:695`; the acceptance criterion for #222.)
7. Enforcement reads `current.mode`; presentation and the last-admin guards read `storedMode`. No site reads the other one.
8. `current.mode === 'disabled' && storedMode !== 'disabled'` always emits `auth_config.open_despite_configuration` at `error`, in **every** `NODE_ENV`.
9. The override masks `mode` and nothing else. Decrypted `clientSecret`/`signingSecret` are **retained** on the break-glass path — clearing them would break the recovery this exists to enable (`routes/settings-auth.ts:114-121` merges the stored secret and 422s `INCOMPLETE_OIDC_CONFIG` if falsy; `:156-160` needs it for the test endpoint; `sanitize()` would falsely report `clientSecretSet: false`). On the decrypt path they remain `null` — they genuinely could not be decrypted.
10. `clientSecretEnc` / `signingSecretEnc` are never cleared by any degrade or override path. (Already asserted at `__tests__/auth-config-plugin.test.ts:204-205, :229`.)
11. `AUTH_STRICT_BOOT` ordering is unchanged: the throw at `auth-config.ts:123-135` still precedes every assignment, and `RECOVERY_DISABLE_AUTH` still short-circuits it at `:123`.

---

## 6. Recovery UX walkthrough — with the footguns named

### A. Local-admin lockout (the `operations.md:695` path) — **strictly improved**

Locked out → set `RECOVERY_DISABLE_AUTH=true`, restart → boot logs `break_glass_override_applied` (warn) **and** `open_despite_configuration` (error, stored mode `local`) → Settings → Authentication shows mode **Local** with a warning alert _"authentication is force-disabled by RECOVERY_DISABLE_AUTH; stored mode is Local"_ → operator resets the password (`routes/settings-auth.ts:229-235` — touches only the user row, calls no `reload()`) → clear the flag, restart → boots into `local`, login required. **Works. No extra step. This is the case the current code silently breaks.**

### B. IdP outage (the `operations.md:585-586` path) — **honest regression: an extra step is now required**

Locked out because the IdP is down → break-glass boot → Settings shows mode **OIDC**, `discoveryStatus: disabled`, plus the break-glass alert. The operator **cannot** re-enable OIDC: `PUT /settings/auth` with `mode: 'oidc'` re-tests discovery server-side (`routes/settings-auth.ts:125-137`) and 422s `TEST_REQUIRED` while the IdP is unreachable. That gate is correct and must not be weakened.

So if the IdP will not come back in time, the operator **must** take an action they did not have to take before: create a local admin (`POST /settings/auth/local-users`) and `PUT` `mode: 'local'` (gated by `NO_LOCAL_ADMIN`, `routes/settings-auth.ts:140-145`), then clear the flag and restart.

**Yes — this makes the original lockout recovery require an extra step.** Today the same operator clears the flag, restarts, and the app "works" — because the row was flipped to `disabled` and the API is wide open. That silent success _is_ #222. Under the fix, changing nothing and clearing the flag lands them back in a closed, still-broken OIDC deployment: a visible failure instead of an invisible one. This must be written into the runbook, not left for the operator to discover.

### C. `CONFIG_ENCRYPTION_KEY` incident — improved, with one new sharp edge

Wrong/missing key → boot logs the decrypt error and degrades to `disabled` in memory; the stored `oidc` row survives. Restore or roll back the key, restart → OIDC comes back with no re-entry, which is what `operations.md:562-567` and `:575-579` already promise.

**New sharp edge:** because the row now stays `oidc`, a deployment with `AUTH_STRICT_BOOT=true` that takes a decrypt degrade will, on the _next_ boot, **refuse to start** (`auth-config.ts:123`) where previously it degraded open. That is the correct security outcome and exactly what strict boot is for, but it changes "restart to resume normal operation" into "the server will not start until the key is fixed, or you set `RECOVERY_DISABLE_AUTH=true`". It must be documented. Note this also silently changes the meaning of the existing `#126 F1` test at `__tests__/auth-config-plugin.test.ts:307`.

### D. Already-damaged deployment — **not remediated by this change**

A deployment that ran break-glass before the fix has a genuinely stored `mode='disabled'`. No code change can resurrect the previous mode. Release note + a "check whether you were affected" runbook step are the whole remedy. Because the anonymous principal is a full ADMIN and the last-admin guard was inert, the runbook must also say: **audit the `users` table for unexpected accounts and delete `sessions` rows** after any past break-glass episode.

### E. Verification step (new, cheap, durable)

After clearing the flag and restarting, prove it: `curl -si http://<host>/api/clusters | head -1` must print `401` (probe already used at `docker/README.md:160-164`). #222's core harm is silence; a proof step is the cheapest permanent mitigation.

---

## 7. Verification plan

Harness: `buildTestServer(envOverrides)` at `__tests__/auth-config-plugin.test.ts:31-38`; `makeTestEnv` at `__tests__/test-helpers.ts:6-22` (a plain object cast to `Env`, so `RECOVERY_DISABLE_AUTH: true` is a real boolean, not a string); `prisma.authConfig.deleteMany({})` runs per-test (`__tests__/setup.ts:16`); `maxWorkers: 1` + `isolate: false` make a two-boot test safe inside one `it()` provided the first instance is closed first.

### Tests to ADD — `apps/server/src/__tests__/auth-config-plugin.test.ts`

1. `'RECOVERY_DISABLE_AUTH=true overrides the mode in memory only, leaving the stored oidc row untouched'` — seed oidc, boot `{ CONFIG_ENCRYPTION_KEY: KEY_B64, RECOVERY_DISABLE_AUTH: true }`. Assert `current.mode === 'disabled'`, `storedMode === 'oidc'`, `breakGlass === true`, `row!.mode === 'oidc'`, `row!.clientSecretEnc` unchanged.
2. **`'restores the stored oidc mode on the next boot once RECOVERY_DISABLE_AUTH is cleared'`** — boot 1 with the flag, assert `disabled`, `await first.close()`; boot 2 without the flag against the same row, assert `current.mode === 'oidc'` and `clientId === 'legacy'`. **This is #222's acceptance criterion. It fails today.**
3. `'the break-glass override survives reload()'` — boot with the flag, `await server.authConfig.reload()`, assert `current.mode` is STILL `'disabled'` **and** `storedMode === 'oidc'`. This is the rotate-signing-secret lockout guard.
4. `'reload() refreshes storedMode when break-glass is not active'` — boot clean, update the row to `oidc` out-of-band, `reload()`, assert `storedMode === 'oidc'`. Guards the stale-`storedMode` fail-open path (§3.4).
5. `'leaves a stored local-mode row intact through a break-glass boot'` — `mode: 'local'`, no key. Asserts `row!.mode === 'local'`, `storedMode === 'local'`.
6. `'the decrypt-failure degrade leaves the stored oidc mode intact'` — wrong key, no break-glass, strict boot off. Assert `current.mode === 'disabled'`, `storedMode === 'oidc'`, `row!.mode === 'oidc'`.

### `apps/server/src/__tests__/auth-plugin.test.ts`

7. `'authStartupWarnings raises an error-level divergence alarm in every NODE_ENV'` — `authStartupWarnings({ current: {…mode:'disabled'}, storedMode: 'oidc', breakGlass: true }, 'test')` contains `{ level: 'error', event: 'auth_config.open_despite_configuration' }`.
8. End-to-end gate proof (`buildServer({ env, prisma })` + `inject`, template at `auth-plugin.test.ts:57-66`): boot with the flag → `GET /api/clusters` 200 anonymous; close; boot without it → 401.

### `apps/server/src/__tests__/settings-auth-routes.test.ts`

9. `'GET /settings/auth reports the stored mode and breakGlassActive during break-glass'` — stored `oidc` + flag: response `mode === 'oidc'`, `breakGlassActive === true`, while `authConfig.current.mode === 'disabled'`.
10. `'the last-admin guard stays armed during break-glass'` — stored `local`, one enabled admin, flag set: `DELETE /settings/auth/local-users/:id` → 422 `LAST_LOCAL_ADMIN`.

### Tests that CHANGE

- `auth-config-plugin.test.ts:179` and `:203` — `expect(row!.mode).toBe('disabled')` → `toBe('oidc')`. Their sibling `expect(server.authConfig.current.mode).toBe('disabled')` at `:177` and `:201` **must survive unchanged** — they are the only guard against shipping a break-glass that is a silent no-op.
- `auth-config-plugin.test.ts:156` and `:227` — same flip, because the decrypt-failure write is now also removed. **Discriminator for review: exactly four `row!.mode` assertions change. If only two change, the decrypt branch was skipped and this note's scope claim is wrong; if none of the `current.mode` assertions survive, the implementer deleted the anti-landmine guard.**
- `auth-config-plugin.test.ts:307` (`#126 F1`) — re-verify: with the row preserved as `oidc`, a strict-boot deployment now refuses the _post-degrade_ boot (§6C). Update or add a sibling case.
- `auth-plugin.test.ts:304-309` — `authStartupWarnings` call sites need the new state shape; `toHaveLength` assertions mostly survive.
- `oidc-plugin.test.ts:127-133` — the `AuthConfigState` fake gains `storedMode: initial.mode, breakGlass: false`. Required for `pnpm typecheck`. It is the only other implementer of the interface.
- Web: `authentication-form` tests for the `breakGlassActive` alert.

### Commands (Docker required for Testcontainers)

```bash
pnpm install
pnpm --filter @lcm/server exec prisma generate
pnpm --filter @lcm/web generate-routes
pnpm lint && pnpm typecheck && pnpm test
pnpm --filter @lcm/server test -- auth-config-plugin auth-plugin settings-auth-routes
pnpm --filter @lcm/web test:e2e
pnpm --filter @lcm/web test:e2e:oidc
pnpm build
```

---

## 8. Docs changes (exhaustive)

| File:line                                                              | Edit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/operations.md:587-589`                                           | "On that boot the server **overrides the effective mode to `disabled` in memory only**. The stored configuration in the DB is left untouched."                                                                                                                                                                                                                                                                                                                                                                                                        |
| `docs/operations.md:591-594`                                           | Keep "clear the flag and restart to resume normal operation" (now true), and **add**: (a) changes saved in Settings during break-glass persist but take effect only after the restart; (b) if the IdP is unreachable you cannot re-enable OIDC — create a local admin and switch to `local` (§6B); (c) verification probe `curl -si http://<host>/api/clusters \| head -1` must print `401`.                                                                                                                                                          |
| `docs/operations.md:562-567`                                           | Now true as written (decrypt degrade no longer overwrites the mode). Add: with `AUTH_STRICT_BOOT=true` the next boot will **refuse to start** until the key is fixed (§6C).                                                                                                                                                                                                                                                                                                                                                                           |
| `docs/operations.md:575-579`                                           | Now true as written. No edit beyond the strict-boot note above.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `docs/operations.md:605-606`                                           | Now true. Add one sentence: the exposure window ends at the next boot without the flag, because the override never mutates stored state.                                                                                                                                                                                                                                                                                                                                                                                                              |
| `docs/operations.md:695`                                               | Delete the restated mechanics; keep only the pointer to "Break-glass: RECOVERY_DISABLE_AUTH". One place to document, no drift.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `docs/operations.md` (new subsection)                                  | "Were you affected?" — pre-fix deployments that ran break-glass have a persisted `mode='disabled'`; re-select the mode in Settings, audit the `users` table for unexpected accounts, delete `sessions` rows.                                                                                                                                                                                                                                                                                                                                          |
| `README.md:113`                                                        | → "Break-glass: forces auth off for that boot only; stored config untouched"                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `.env.example:59-63`                                                   | Add: "the override is in-memory for that boot only and never rewrites the stored auth config." Highest-leverage single line — it sits next to the value the operator toggles.                                                                                                                                                                                                                                                                                                                                                                         |
| `docker/docker-compose.yml:76-77`                                      | Match the `.env.example` wording.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `CLAUDE.md:193`                                                        | Append the invariant: "…the break-glass override is in-memory for that boot only and never mutates stored auth config." Makes the rule binding for future degrade paths.                                                                                                                                                                                                                                                                                                                                                                              |
| `apps/server/src/plugins/auth-config.ts:79-84`                         | Rewrite docstring step 4: in-memory override via `enforce()`, applied to the boot value and every `reload()`, never writes the row.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `apps/server/src/plugins/auth-config.ts:58-70`                         | Update step 3 to match the decrypt branch no longer writing. Also correct the stale rationale inherited from `docs/superpowers/plans/2026-07-03-oidc-settings-ui.md:456`: `service.update()` with `{mode:'disabled'}` would **not** re-encrypt secrets (`services/auth-config.ts:236-243` never fires); the real reasons are that it unconditionally rewrites `scopes`/`defaultRole`/`sessionTtlHours`/`allowInsecure` to Zod defaults (`:219-226`), stamps `updatedByUserId`, and needs a fully-populated `AuthConfigUpdate` the guard cannot build. |
| `apps/server/src/plugins/auth-config.ts:173-176`                       | Rewrite the warn: stored config preserved; removing the flag + restarting fully restores it; the override also survives in-session reloads. This is what the operator reads during the incident.                                                                                                                                                                                                                                                                                                                                                      |
| `docs/superpowers/specs/2026-07-03-oidc-settings-ui-design.md:182-184` | One-line annotation: "Superseded 2026-07-18 (#222) — the override is in-memory only." Leave the rest as history.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `docs/superpowers/specs/2026-07-06-local-admin-auth-design.md:227-229` | Same annotation — this is where the load-bearing "re-select the mode" step was dropped.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `docker/README.md:170-172`                                             | **No change** — pure cross-reference. Explicitly cleared so reviewers don't hunt.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

---

## 9. Rollback / containment

- **Blast radius:** one Fastify plugin, one route file, one shared schema (additive), one web component, docs. No Prisma migration, no schema change, no data migration. `crypto/secret-box.ts` untouched.
- **Rollback:** `git revert` the merge commit. The change is code-only and additive to the contract, so reverting restores the previous behaviour exactly. No stored data is written differently by the new code (it writes _less_), so a revert cannot strand rows in an unreadable state.
- **Forward containment if the override misbehaves in production:** every plausible bug in `enforce()` fails **closed** — a missed or inverted override yields `current.mode` = stored mode = API gated = operator locked out, never an unexpected open API. The one exception is a stale `state.storedMode` round-tripping through the Settings form (§3.4), which test 4 exists specifically to prevent. If it somehow ships, containment is: do not save in Settings while break-glass is active; clear the flag and restart.
- **Break-glass on the break-glass:** unchanged. `RECOVERY_DISABLE_AUTH=true` + restart still opens the API. Note the pre-existing hazard, not introduced here: a malformed-but-present `CONFIG_ENCRYPTION_KEY` throws in `loadKey` at `auth-config.ts:90`, _before_ any recovery logic, so break-glass does not rescue that case.
- **Deploy path:** `feat/222-break-glass-in-memory` off `dev` in a worktree → PR into `dev` → `:dev` images → soak → `dev → main` sync PR → `:latest`. Pin with `LCM_IMAGE_TAG` to roll back an image without a code revert.
- **Human approval:** required before implementation per CLAUDE.md (auth + shared contract = HIGH risk). AI review supplements, does not replace.

---

## 10. Open questions for the project owner

1. **Scope of the decrypt-failure branch (`auth-config.ts:150-153`).** This note includes it (§3.5) because excluding it leaves #222 unfixed whenever the key is also broken, and makes the rewritten runbook conditionally false. Cost: a larger, higher-risk PR, four test assertions flipping instead of two, and the strict-boot behaviour change in §6C. **Confirm in-scope, or split it and I will rewrite §8 to say the operator must re-select the mode after a key incident.**
2. **The `@lcm/shared` contract change (`breakGlassActive` + `sanitize()` reporting `storedMode`).** High-risk per CLAUDE.md and needs explicit approval. It is load-bearing, not cosmetic: without it the Settings form re-persists `disabled` and reintroduces #222 through the UI on the first save. The alternatives (server-side coercion, blanket reject) are both rejected in §4 for concrete security reasons. **Approve, or nominate a different mechanism.**
3. **The §6B regression is accepted?** During an IdP outage, the operator can no longer clear the flag and have the app "work" — they must create a local admin and switch to `local`, or fix the IdP. That is the intended security outcome, but it is a real change to the documented emergency path. **Confirm, so it can be written into the runbook as the primary IdP-outage procedure.**
4. **`OIDC_ALLOW_INSECURE` in the production deployment.** Unverified — CLAUDE.md prohibits reading the repo-root `.env`. If it is set, the SSRF row in §2 escalates from "public hosts only" to full internal SSRF including `169.254.169.254` during any break-glass window. **Please confirm; it changes the severity narrative, not the fix.**
5. **Post-incident audit guidance (§6D).** Should the runbook mandate auditing the `users` table and revoking `sessions` after _every_ break-glass episode, or only after one where exposure is suspected? The mandatory version is safer; the conditional version is what operators will actually do.
