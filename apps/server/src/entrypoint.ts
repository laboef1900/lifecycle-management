// Production container entrypoint. Replaces docker/server-entrypoint.sh
// (which can't run in the distroless runtime image — there's no shell,
// no apk, no pnpm). DHI's node:22-alpine has only `node` and
// /usr/bin/env, so this module is what `CMD` points at.
//
// Responsibilities, in order:
//   1. Apply Prisma migrations (always idempotent).
//   2. If SEED_ON_BOOT=true, run the seed.
//   3. Dynamically import ./index.js to start the Fastify server.

import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
// dist/src/entrypoint.js → repo deploy root is two levels up.
const deployRoot = resolve(here, '..', '..');
const prismaCli = resolve(deployRoot, 'node_modules', 'prisma', 'build', 'index.js');
const seedScript = resolve(deployRoot, 'dist', 'prisma', 'seed.js');

function log(msg: string): void {
  console.log(`[lcm-server] ${msg}`);
}

function runNode(args: string[], label: string): void {
  const opts: SpawnSyncOptions = {
    cwd: deployRoot,
    stdio: 'inherit',
    env: process.env,
  };
  const result = spawnSync(process.execPath, args, opts);
  if (result.status !== 0) {
    console.error(`[lcm-server] ${label} failed (exit ${result.status})`);
    process.exit(result.status ?? 1);
  }
}

log('applying database migrations...');
runNode([prismaCli, 'migrate', 'deploy'], 'prisma migrate deploy');

if (process.env.SEED_ON_BOOT === 'true') {
  log('SEED_ON_BOOT=true — seeding reference data...');
  runNode([seedScript], 'seed');
}

log(`starting server on ${process.env.HOST ?? '0.0.0.0'}:${process.env.PORT ?? '8080'}`);
await import('./index.js');
