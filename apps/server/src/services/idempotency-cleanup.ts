import type { PrismaClient } from '@prisma/client';

/** Drain budget on shutdown — same order of magnitude as the vSphere scheduler's. */
const DRAIN_TIMEOUT_MS = 5_000;

/** How often the sweep runs. Fixed, not a setting: retention is measured in
 * hours, so a 15-minute tick is comfortably tight without being configurable
 * surface area nobody asked for. */
export const CLEANUP_INTERVAL_MS = 15 * 60 * 1000;

/** Mirrors the small logger shape `VsphereClientInventoryCollector` takes from its plugin. */
export interface IdempotencyCleanupLogger {
  warn: (details: unknown, message: string) => void;
}

const NOOP_LOGGER: IdempotencyCleanupLogger = { warn: () => undefined };

/**
 * Purges expired `idempotency_keys` rows (#263). Deliberately simpler than
 * `VsphereScheduler`: a plain `DELETE ... WHERE expires_at < now()` is
 * naturally safe to run concurrently from multiple instances with no
 * claim/lease needed — unlike coordinating exclusive outbound vCenter calls,
 * there is no external resource here to serialize access to.
 */
export class IdempotencyCleanup {
  private timer: NodeJS.Timeout | null = null;
  private activeRun: Promise<number> | null = null;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly logger: IdempotencyCleanupLogger = NOOP_LOGGER,
  ) {}

  start(intervalMs: number = CLEANUP_INTERVAL_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.sweep().catch(() => undefined);
    }, intervalMs);
    this.timer.unref();
  }

  isRunning(): boolean {
    return this.timer !== null;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.race([this.activeRun ?? Promise.resolve(0), delay(DRAIN_TIMEOUT_MS)]);
  }

  /**
   * Deletes every row past its `expiresAt`. Never throws — a failed sweep is
   * logged (so a persistently broken sweep is visible in the server log
   * rather than silently never running) and returns 0; the next tick tries again.
   */
  async sweep(): Promise<number> {
    const run = this.prisma.idempotencyKey
      .deleteMany({ where: { expiresAt: { lt: new Date() } } })
      .then((result) => result.count)
      .catch((err: unknown) => {
        this.logger.warn({ err }, 'idempotency-key cleanup sweep failed');
        return 0;
      });
    this.activeRun = run;
    try {
      return await run;
    } finally {
      this.activeRun = null;
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}
