import 'dotenv/config';

import { parseEnv } from './env.js';
import { buildServer } from './server.js';

async function main(): Promise<void> {
  const env = parseEnv();
  const server = await buildServer({ env });

  const shutdown = async (signal: string): Promise<void> => {
    server.log.info({ signal }, 'Shutting down');
    await server.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

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
