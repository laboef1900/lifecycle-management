import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

const apiDir = dirname(fileURLToPath(import.meta.url));

let container: StartedPostgreSqlContainer | undefined;

export async function setup(): Promise<void> {
  // Pinned to the production Postgres major (docker-compose.yml runs
  // dhi.io/postgres:18) so integration tests exercise the same engine version.
  container = await new PostgreSqlContainer('postgres:18-alpine')
    .withDatabase('lcm_test')
    .withUsername('lcm')
    .withPassword('lcm')
    .start();

  const databaseUrl = container.getConnectionUri();
  process.env.DATABASE_URL = databaseUrl;

  applyMigrations(databaseUrl);
  await seedDefaults(databaseUrl);
}

export async function teardown(): Promise<void> {
  await container?.stop();
}

function applyMigrations(databaseUrl: string): void {
  const result = spawnSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: apiDir,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (result.status !== 0) {
    throw new Error(`prisma migrate deploy failed with exit code ${result.status ?? 'null'}`);
  }
}

async function seedDefaults(databaseUrl: string): Promise<void> {
  const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  try {
    await client.tenant.upsert({
      where: { id: 'default' },
      update: { name: 'Default' },
      create: { id: 'default', name: 'Default' },
    });
    await client.metricType.upsert({
      where: { key: 'memory_gb' },
      update: { displayName: 'Memory', unit: 'GB' },
      create: { key: 'memory_gb', displayName: 'Memory', unit: 'GB' },
    });
  } finally {
    await client.$disconnect();
  }
}
