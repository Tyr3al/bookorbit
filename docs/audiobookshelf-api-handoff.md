# Audiobookshelf API compatibility handoff

## Status

Work stopped after the author and series SQL pagination fixes, per the user's request. The active
branch is `feature/audiobookshelf-api`.

The working tree should contain only these user-owned untracked paths in addition to this document:

- `.reasonix/`
- `docs/handover.md`

Do not edit, delete, stage, or commit those paths. The older `docs/handover.md` describes the
original Prologue series and collections investigation. This document covers the broader API
compatibility work that followed it.

## Runtime state

- PostgreSQL development container: `bookorbit-dev-db`
- PostgreSQL host port: `5433`, matching `server/.env`
- Migrations were applied with `cd server && pnpm db:migrate`.
- The Nest development server was started with `pnpm run dev:server`.
- The server answered `200` at `http://127.0.0.1:3000/abs/status` after the final implementation
  commit.
- In a sandboxed agent session, both Docker access and the server process need escalation because
  the server connects to PostgreSQL over localhost and listens on port 3000.

If startup fails with a wrapped Drizzle query error and no database cause, first check whether the
command was launched outside the network sandbox. The same failure occurred here as `connect
EPERM` until `pnpm run dev:server` was run with escalation.

## Commits completed in this pass

Each fix or feature has its own commit:

```text
4d439a2c fix(server): prevent ABS identifier collisions
77d10fc5 fix(server): scope ABS author details
74bec80e fix(server): scope ABS series details
dd2a505e fix(server): scope ABS library collections
87ae9d5f fix(server): return JSON for unknown ABS APIs
ad93a5b1 fix(server): align ABS item list sorting
887d249a fix(server): retain permissions on ABS refresh
0bdfb46b fix(server): scope ABS progress responses
67d44f75 fix(server): reject stale ABS progress updates
cb09ec7b fix(server): honor ABS finished progress state
7090f531 feat(server): add ABS POST authorize route
8861a409 feat(server): add ABS library detail route
2e091257 feat(server): add ABS progress list route
6a52447e feat(server): add ABS progress deletion
f68da75f feat(server): add ABS direct playback sessions
50e9184d feat(server): add ABS playback session sync
59127577 feat(server): add ABS playback session close
1b9ecc72 feat(server): add ABS local session sync
56d7988a feat(server): add ABS items in progress
3783ede1 feat(server): add ABS batch item retrieval
97511324 feat(server): add ABS audiobook bookmarks
b77dfaff feat(server): add ABS personalized shelves
97c3b0ba fix(server): stabilize ABS filter data
9c1387b0 perf(server): paginate ABS authors in SQL
1f42e678 perf(server): paginate ABS series in SQL
```

Earlier compatibility commits on the branch include the original series-shape fixes, local-all
session upload, filter data, conditional GET support, and dropped-socket crash protection. Use
`git log --oneline -- server/src/modules/audiobookshelf server/src/main.ts` for the complete chain.

## Important implementation details

- ABS numeric identifiers use deterministic UUIDs. Series has a separate UUID namespace to avoid
  collisions with books, authors, and libraries.
- Every read and mutation must remain scoped by user, exposed library, audio content, visibility,
  and content filters.
- Progress IDs and playback session IDs are deterministic user/book composite UUIDs. Playback
  sessions are stateless rather than persisted.
- Progress writes reject stale timestamps atomically and honor explicit finished or reopened book
  status.
- Bookmark endpoints reuse BookOrbit's native `bookmarks` table. Audio bookmarks have `cfi = null`
  and use `positionSeconds`; deletion remains tombstone-based for KOReader sync safety.
- Personalized shelves currently provide bounded `continue-listening` and `recently-added` shelves.
- Paginated author and series lists now sort, count, limit, and offset in SQL. Series memberships
  are batch-loaded and grouped so multi-file audiobooks do not appear more than once.
- `filterdata.loadedAt` now derives from persisted library state, so unchanged JSON retains a
  stable ETag.

## Verification completed

The changed areas were repeatedly checked with focused Vitest suites, touched-file ESLint,
Prettier, `git diff --check`, and the server type-check:

```bash
cd server
pnpm type-check
pnpm vitest run src/modules/audiobookshelf
pnpm exec eslint src/modules/audiobookshelf
```

The final focused pagination checks passed, and the development server reported zero TypeScript
issues while watching. Commit hooks also ran ESLint and Prettier for every staged TypeScript file.

## Remaining work, in priority order

### 1. Remove the temporary response-header diagnostic

`server/src/main.ts` still contains a block beginning with `TEMP DIAGNOSTIC` that removes Helmet,
CORS, and request-id headers from ABS routes. This was an experiment for Prologue and should not
ship without an explicit decision. Remove it as a dedicated fix, then verify `/abs/status`, login,
streaming, and conditional GET behavior.

### 2. Correct library search compatibility

`AudiobookshelfLibrariesService.searchLibrary()` currently returns minified books directly under
`book` and leaves authors and series empty. Compare its exact shape against current upstream
Audiobookshelf before changing it. Also validate missing or blank `q`, preserve SQL bounds, and
return author and series matches without scanning the full library.

Useful upstream source:

- `server/controllers/LibraryController.js`, method `search`
- `server/utils/queries/libraryItemFilters.js`, method `search`

### 3. Finish large-library query cleanup

- `getFilterData()` still loads every matching book ID only to compute `bookCount`. Replace this
  with an aggregate count.
- Collection pagination still loads the complete collection set before slicing.
- Global author detail can build a whole-library book ID set before selecting one author's books.
- The unpaginated author contract returns every author by design. Keep the compatible shape, but
  avoid using it internally and document its cost.
- Batch progress and local-all session updates are serial per item. Add one scoped access lookup
  and bounded writes while preserving per-item failure tolerance.

### 4. Fill remaining player-facing endpoints

- `GET /api/libraries/:id/playlists` and playlist detail or mutation routes are absent. BookOrbit
  currently has no playlist persistence, and library detail always reports `numUserPlaylists: 0`.
  This likely needs a schema design and generated Drizzle migration.
- Listening-session routes currently return empty stubs. Listening statistics are also absent.
- Personalized shelves only implement Continue Listening and Recently Added. Upstream also emits
  Continue Series, Recent Series, Discover, Listen Again, and Newest Authors when applicable.
- Real-time Socket.IO user and library update notifications are not implemented for the ABS
  compatibility API.

### 5. Tighten remaining response semantics

- Author `addedAt` and `updatedAt` are still `0` because BookOrbit authors have no direct timestamp
  columns. Derive stable timestamps from persisted relationships or add schema fields only after a
  deliberate data model decision.
- Item list handling reports `minified: true` and does not fully implement `collapseseries`.
- Review optional `include` fields across personalized shelves, series, authors, and items.
- Run a fresh comparison against current Audiobookshelf for every changed route before broadening
  the API. Prefer upstream source and captured real-server responses over third-party API docs.

## Recommended next-agent workflow

1. Read `AGENTS.md`, this document, and the existing untracked `docs/handover.md` without modifying
   the latter.
2. Confirm `git status --short` contains no unexpected files.
3. Confirm the server and database are healthy.
4. Start with the temporary header diagnostic because it is clearly marked for removal.
5. Continue one fix or feature at a time, with one commit each.
6. For every API change, verify route and method, DTO validation, response fields, user scope,
   content filters, large-library bounds, focused tests, lint, formatting, and type-check.

The user explicitly requested Luna subagents to reduce token use. Continue using Luna for bounded
implementation tasks, then review and commit from the primary agent.
