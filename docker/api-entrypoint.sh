#!/bin/sh
set -e

echo "[lcm-api] applying database migrations..."
pnpm exec prisma migrate deploy

if [ "${SEED_ON_BOOT:-false}" = "true" ]; then
  echo "[lcm-api] SEED_ON_BOOT=true — seeding reference data..."
  pnpm exec prisma db seed
fi

echo "[lcm-api] starting server on ${HOST:-0.0.0.0}:${PORT:-8080}"
exec pnpm exec tsx src/index.ts
