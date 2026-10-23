import type { Config } from 'drizzle-kit';

import { FORK_MIGRATIONS_TABLE } from './src/db/fork-migrations.constants';

export default {
  schema: './src/db/fork-schema/index.ts',
  out: './src/db/migrations/fork',
  dialect: 'postgresql',
  tablesFilter: ['abs_*'],
  migrations: { table: FORK_MIGRATIONS_TABLE, schema: 'drizzle' },
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://bookorbit:bookorbit@postgres:5432/bookorbit',
  },
} satisfies Config;
