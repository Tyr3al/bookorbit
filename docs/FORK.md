# Fork maintenance

This repository is a fork of [bookorbit/bookorbit](https://github.com/bookorbit/bookorbit) that adds
an Audiobookshelf-compatible API. Upstream closed that feature as not planned
([#650](https://github.com/bookorbit/bookorbit/issues/650)), so the fork is expected to live on its
own and track upstream releases.

## Rules

1. **Never change an upstream table.** No new columns, constraints, indexes or check values on tables
   defined in `server/src/db/schema/`. Upstream regenerates those objects freely (it has recreated
   the `reading_sessions` source check nine times), and any fork change would be dropped or would make
   upstream's next migration fail. Store fork data in fork-owned tables that reference upstream ones.
2. **Fork tables live in `server/src/db/fork-schema/`** and are not exported from the main schema.
   Query them with the query builder.
3. **Fork migrations have their own track.** Generate with `cd server && pnpm db:generate:fork <name>`
   (config `drizzle.fork.config.ts`). They land in `server/src/db/migrations/fork/` with their own
   journal and the `drizzle.__drizzle_fork_migrations` ledger, and `migrate.ts` runs them after the
   upstream migrations. Never hand-write the SQL, and never put a fork migration in the main folder.
4. **Keep edits to upstream files small and additive.** Each one is a potential conflict at every
   upstream release. Prefer fork-owned files, modules and settings pages.

## Syncing an upstream release

```bash
git fetch upstream
git checkout BO-650-audiobookshelf-api
git merge <release-tag>        # e.g. v1.42.0; merge, never rebase, so the branch history stays valid
```

1. Resolve conflicts. `server/src/db/migrations/` outside `fork/` must end up identical to upstream:
   `git diff <release-tag> -- server/src/db/migrations ':!server/src/db/migrations/fork'` is empty.
2. `pnpm install`, then `pnpm --filter @bookorbit/types build`.
3. `cd server && pnpm db:generate:fork check` must report no changes; if it creates a migration,
   upstream changed a table a fork table references. Review it before keeping it.
4. Run `pnpm verify`, and the `audiobookshelf-api` and `authorization-matrix` e2e suites
   (`pnpm run e2e:run -- <suite-id>`). New upstream routes do not affect the fork; new fork routes must
   be added to `server/test/e2e/authorization-matrix/route-inventory/routes-11.json`.
5. Smoke test an ABS client (login, play, sync) against the merged build before deploying.

## Where the fork touches upstream code

Mostly additive hooks; check these first when a merge conflicts or an upstream refactor breaks the
build:

- `server/src/app.module.ts`: registers `AudiobookshelfModule` under `/abs`.
- `server/src/main.ts`, `server/test/e2e/app-harness.ts`: global-prefix excludes for `/abs`,
  conditional GET, socket error guard, Audiobookshelf marker page in the 404 handler.
- `server/src/scripts/migrate.ts`, `server/package.json`: the fork migration track.
- `server/src/modules/auth/`: `JwtModule` export and `?token=` extraction scoped to `/abs`.
- `server/src/modules/book/book.service.ts`: `readCoverPath`, and `saveAudioProgress` accepting a
  client timestamp and an explicit finished state.
- `server/src/modules/reading-session/`: `recordListeningSession`, `findLatestSourceSession`, and
  `saveSession` accepting a null source.
- `server/src/modules/bookmark/`, `server/src/modules/app-settings/`, `server/src/config/`: ABS
  bookmark queries, the global enable switch and `JWT_ABS_EXPIRES_IN`.
- `server/src/modules/seed/seed.service.ts`, `server/.env.example`: defaults for the switch and
  `JWT_ABS_EXPIRES_IN`.
- `packages/types/src/index.ts`: exports `audiobookshelf.ts`.
- `scripts/e2e/suite-registry.mjs`: the `audiobookshelf-api` e2e suite.
- `server/test/e2e/authorization-matrix/route-inventory/`: `routes-11.json` and the manifest totals.
- Client: the Audiobookshelf settings page, its nav entry and route, and its `en.json` strings.
