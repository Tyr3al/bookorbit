/**
 * Schema owned by this fork rather than upstream BookOrbit. It has its own drizzle config
 * (drizzle.fork.config.ts), migrations folder (src/db/migrations/fork) and ledger table, so
 * upstream merges never touch fork migrations and upstream migrations are never skipped because
 * of a newer fork migration. Fork tables must not alter upstream tables; reference them only.
 * Not part of the main `schema` object: query these tables with the query builder.
 */
export * from './audiobookshelf';
