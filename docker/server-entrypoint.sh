#!/bin/sh
set -e

echo "[lcm-server] applying database migrations..."
pnpm exec prisma migrate deploy

if [ "${SEED_ON_BOOT:-false}" = "true" ]; then
  echo "[lcm-server] SEED_ON_BOOT=true — seeding reference data..."
  pnpm exec prisma db seed
fi

echo "[lcm-server] starting server on ${HOST:-0.0.0.0}:${PORT:-8080}"
exec pnpm exec tsx src/index.ts
