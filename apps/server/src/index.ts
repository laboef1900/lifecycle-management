import 'dotenv/config';

import { parseEnv } from './env.js';
import { buildServer } from './server.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

async function main(): Promise<void> {
  const env = parseEnv();
  const server = await buildServer({ env });

  let shuttingDown = false;
  const shutdown = async (signal: string, exitCode = 0): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.log.info({ signal }, 'Shutting down');
    const timer = setTimeout(() => {
      server.log.error('Shutdown timed out; forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    // unref: the timer must not keep the process alive on its own. Hangs we
    // guard against (sockets, DB disconnect) hold refed handles, so the loop
    // stays alive and the timer still fires.
    timer.unref();
    await server.close();
    process.exit(exitCode);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    server.log.error({ err: reason }, 'Unhandled promise rejection');
    void shutdown('unhandledRejection', 1);
  });
  process.on('uncaughtException', (err) => {
    server.log.error({ err }, 'Uncaught exception');
    process.exit(1);
  });

  try {
    await server.listen({ port: env.PORT, host: env.HOST });
  } catch (err) {
    server.log.error({ err }, 'Failed to start server');
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
