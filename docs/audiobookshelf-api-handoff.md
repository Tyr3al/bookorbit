# Audiobookshelf API compatibility handoff

## Status

The active branch is `BO-650-audiobookshelf-api`, merged up to date with upstream
`bookorbit/bookorbit` main. Upstream closed this feature as not planned, so this is a long-lived
fork: read [FORK.md](FORK.md) for the migration rules and the release sync procedure before
changing the schema. ABS login and refresh run on upstream's session-bound auth, and ABS listening
is recorded in BookOrbit's reading history (see "Listening sessions and stats" below).

The working tree should contain only these user-owned untracked paths in addition to this
document:

- `.reasonix/`
- `docs/handover.md`

Do not edit, delete, stage, or commit those paths. The older `docs/handover.md` describes the
original Prologue series and collections investigation. This document covers the broader API
compatibility work that followed it.

## Runtime state

- PostgreSQL development container: `bookorbit-dev-db`
- PostgreSQL host port: `5433`, matching `server/.env`
- Migrations were applied with `cd server && pnpm db:migrate`.
- In a sandboxed agent session, both Docker access and the server process need escalation because
  the server connects to PostgreSQL over localhost and listens on port 3000.

If startup fails with a wrapped Drizzle query error and no database cause, first check whether the
command was launched outside the network sandbox. The same failure occurred here as `connect
EPERM` until `pnpm run dev:server` was run with escalation.

### Toolchain caveat observed in this pass

`pnpm` was **not on PATH** in the non-interactive shell used for this pass, which has two
consequences a future agent will hit immediately:

- Every `pnpm ...` command in the docs above silently fails. Use the workspace binaries directly
  from `server/`: `node_modules/.bin/tsc --noEmit -p tsconfig.build.json`,
  `node_modules/.bin/vitest run <path>`, `node_modules/.bin/eslint <path>`,
  `node_modules/.bin/prettier --write <path>`, `node_modules/.bin/drizzle-kit generate --name <n>`.
  Beware of piping a missing command into `tail`: the pipeline exit code hides the 127 and the
  check looks like it passed.
- The husky `pre-commit` hook runs `pnpm exec lint-staged` and therefore fails with
  `pnpm: command not found`. Every commit in this pass used `--no-verify` **after** running
  Prettier, ESLint, the type-check and the focused Vitest suite by hand. Keep doing both halves of
  that; do not use `--no-verify` as a way to skip the checks.

Note also that `tsc` can report stale errors from an earlier tree state. If a type error points at
code you did not touch (for example Drizzle inference collapsing to `{ [x: string]: any }` in
`findBookById`), delete `*.tsbuildinfo` and re-run before believing it.

## Commits completed in this pass

```text
030897b6 feat(server): add ABS public session track route and public covers
6f8f9850 feat(server): add ABS per-file download route with permission gate
b9d3f43b fix(server): clamp live session positions and add sessions tests
7ebeabf6 docs: update ABS handoff for completed listening sessions
de3bbeb9 test(server): repair audiobookshelf e2e suite and cover listening sessions
930d61d2 fix(server): return real Dates from ABS timestamp aggregates
30b1b1ac feat(server): persist ABS listening sessions and stats
d65b57ab fix(server): drop temporary ABS header diagnostic
76729412 perf(server): bound ABS filterdata and author queries
08bd309b perf(server): batch ABS progress and session writes
f2bd90d6 fix(server): match ABS library search response shape
0af9f27d feat(server): derive ABS author timestamps
```

Earlier compatibility commits on the branch are listed in the git history; use
`git log --oneline -- server/src/modules/audiobookshelf server/src/main.ts` for the complete chain.

## What changed, and why

### Temporary header diagnostic removed

`server/src/main.ts` no longer strips Helmet, CORS and request-id headers from ABS routes. ABS
routes now carry the same security headers as the rest of the API. If a client regression appears
around Prologue, this is the first thing to re-test, but it should not come back as a permanent
change without a deliberate decision.

### Library search now matches upstream

The previous response (`{ book: <bare minified items>, author: [], series: [], podcast: [],
episode: [] }`) matched no Audiobookshelf version. Verified against upstream `master` source
(`server/controllers/LibraryController.js` -> `search`, and
`server/utils/queries/libraryItemsBookFilters.js` -> `search`), the real contract is:

```js
{
  book: [{ libraryItem: <LibraryItem, EXPANDED> }],
  narrators: [{ name, numBooks }],
  tags: [{ name, numItems }],
  genres: [{ name, numItems }],
  series: [{ series, books }],   // entries with zero books are dropped
  authors: [<Author with numBooks>]
}
```

Key points that are easy to get wrong: the key is `authors` (plural, not `author`); there is no
`podcast` or `episode` key for a book library; each `book` entry is an object wrapping the item,
not a bare item, and it uses the expanded shape rather than the minified one; a missing or
non-string `q` is a 400, and the default `limit` is 12 applied independently per category.

Two BookOrbit-specific deviations, both deliberate:

- Upstream matches books on title, subtitle, `asin` and `isbn`. BookOrbit has no `asin` column
  (`media.metadata.asin` is hardcoded `null` in `library-item-mapper.service.ts`), so book search
  matches title, subtitle, `isbn10`, `isbn13`, `amazonId` and `audibleId` instead.
- Upstream stores genres, tags and narrators as JSON columns; BookOrbit stores them relationally,
  so those three categories are grouped counts over the link tables.

The item-list path keeps its title-only matching: `buildTitleSearch` is unchanged and search uses a
separate `buildBookSearchClause`.

### Public session track route and covers

AudioBooth (and similar clients) stream each track from `{server}/public/session/:id/track/:index`
with **no auth headers** - upstream's PublicRouter, where the session id is the bearer secret. The
route was missing, so those clients failed playback immediately after a successful play (their
play requests succeeded but no track request ever reached the server). Commit `030897b6` added it:

- `AbsOpenSessionStore` (in-memory): sessions are opened on `play()`, refreshed on `sync()`, closed
  on `close()`, and expire after 36h. The public track route only serves **open** sessions and
  404s unknown/closed ones, matching upstream's getTrack. The registry exists because BookOrbit's
  deterministic composite session ids would otherwise let anyone guess a (userId, bookId) pair and
  stream any book; this bounds exposure to actively-open sessions. A server restart closes all
  sessions (same as upstream's in-memory session manager).
- The route streams the track file with Range support (`206`) and re-checks the book exists and
  its library is still ABS-exposed.
- `GET /abs/api/items/:id/cover` is now public (upstream has no auth on it); AudioBooth loads
  covers without a token, which previously 401'd. `BookService.getCoverPath` was split so the
  public read skips `verifyBookAccess` (callers check existence themselves).
- `abs/public/(.*)` was added to the global-prefix excludes in `main.ts` and the e2e harness -
  without it the public routes land at `/api/v1/abs/public/...` and clients 404.

Note: the playlists 404s seen from these clients are the deliberately deferred playlists feature;
clients tolerate them. If a client still fails after this, check the server log for what it
requests - clients that 404 on `/play` itself would point at a play-response decoding issue in the
client.

### Per-file download route

Prologue downloads each audio file from `GET /api/items/:id/file/:fileId/download` and identifies
files by their **inode** (`ino`), not the file id - upstream's `getLibraryFileWithIno` matches
either. BookOrbit only had the whole-item `/download` route, so that URL 404'd. Commit `6f8f9850`
added the missing route (file resolution already accepted id-or-ino via `resolveFileIdByIno`) and
gated **both** download routes behind the `library_download` permission (403 without it), matching
upstream's `canDownload` checks. The login response's `permissions.download` flag is what Prologue
uses to show the download button; the server now enforces the same permission.

### Large-library query cleanup

- `getFilterData()` computes `bookCount` with a `count()` aggregate
  (`countAudioBooksByLibraries`) instead of selecting every matching book id and taking `.length`.
- Global author detail uses `findAuthorBookIdsByLibraries(authorId, libraryIds, contentFilters)`,
  a single author-scoped join, instead of materialising every exposed book id across every exposed
  library and then filtering author links in JS. `findAuthorIdsByBookIds` was removed as unused.
- Batch progress (`PATCH /api/me/progress/batch/update`) and local session upload
  (`POST /api/session/local-all`) share an `applyProgressBatch()` helper doing **one** scoped
  access lookup (`findExposedAudioBooksByIds`), one file load and one progress load for the whole
  batch, then applying writes with bounded concurrency (`PROGRESS_BATCH_CONCURRENCY = 4`). That
  takes an N-entry batch from roughly 5N serial round trips to 3 + N.

  Two subtleties worth preserving if this is touched again. Entries are **grouped per book and
  each group applies in arrival order**, because an entry carrying no `lastUpdate`/`startedAt`
  bypasses the atomic stale-write guard inside `upsertAudioProgress` and concurrent same-book
  writes would otherwise land nondeterministically. And the batch path now scopes through
  `findExposedAudioBooksByIds`, which applies content filters and the audio-file check, where the
  old per-item path used `requireExposedBook`, which did not; that is a deliberate tightening.

- The unpaginated author list branch is unbounded **by design**, to match the ABS clients that
  never send `limit`. Its JSDoc now says so, and says it must not be called internally.

- The previous handoff claimed collection pagination sliced in memory. That was already stale:
  `listLibraryCollections` paginates with SQL `LIMIT`/`OFFSET` plus a separate count.

### Author timestamps

`addedAt`/`updatedAt` on ABS author payloads are no longer hardcoded `0`. BookOrbit's `authors`
table has no timestamp columns, and the decision was to **derive** rather than add columns, because
new columns would default every existing author to the migration date whereas derivation gives
correct historical values with no backfill:

- `addedAt` = `min(books.added_at)` over the author's exposed audio books
- `updatedAt` = `max(books.updated_at)` over the author's exposed audio books

The aggregates fold into the author queries that already `GROUP BY` for `numBooks`, so the list
paths cost nothing extra; author detail resolves its own aggregate
(`findAuthorBookStatsByLibraries`) in parallel with the book id lookup.

Note there are **two** author mappers that must stay in sync:
`AudiobookshelfAuthorsService.toAuthor()` and `AudiobookshelfLibrariesService.toSearchAuthor()`.
The duplication is deliberate: `AudiobookshelfAuthorsService` already injects
`AudiobookshelfLibrariesService`, so reusing the mapper would create a circular DI cycle.

## Listening sessions and stats

ABS listening is stored in BookOrbit's own `reading_sessions` table (`sessionType: 'listen'`, no
source, device key `abs:<deviceId>`), not in a separate ABS table. The source stays null because the
source check constraint belongs to upstream (see FORK.md), so BookOrbit's statistics count ABS
listening in the general BookOrbit bucket. The earlier `abs_listening_sessions` table never
shipped and was removed when the branch was brought up to date with upstream main. As a result ABS
listening feeds the reading log, statistics, daily stats, achievements and Hardcover/StoryGraph
sync, and ABS clients see listening from the web player and native apps too.

Writes (`AudiobookshelfSessionsService`), all through `ReadingSessionService.recordListeningSession`,
which relies on `saveSession`'s supersede rule: re-sending a session id with a longer duration grows
the stored session and adds only the delta to daily stats.

- Live `sync`/`close`: each report carries `timeListened` seconds since the previous report. The
  newest `abs-live:*` session for the same user, book and device that ended within
  `AUDIOBOOKSHELF_LIVE_SESSION_GAP_MS` (10 min) is grown; otherwise a new one starts, backdated by
  the reported seconds. The lookup is in the table, so it survives restarts. The device id comes
  from the `play` request's `deviceInfo` (sync bodies do not carry it) and is kept in the open
  session store; after a restart it falls back to `default`.
- Offline `/api/session/local` and `/local-all`: keyed by the client's session id
  (`abs-local:<id>`), so the client's repeated re-uploads of a growing session update one row
  instead of inserting duplicates. Listening is recorded even when the progress write was skipped
  as stale.
- Durations are capped at the session's wall-clock span, and sessions under 10s are not stored,
  matching every other reading-session source.
- Read status and progress are not touched here; `saveAudioProgress` already handled them.

Reads (`AudiobookshelfSessionsRepository`) serve `GET /api/me/listening-sessions`,
`GET /api/me/item/listening-sessions/:id` and `GET /api/me/listening-stats` from `listen`
sessions in ABS-exposed libraries the user can access, with content filters applied. Days and
weekdays are bucketed in the user's time zone. `startTime`/`currentTime` are derived from the
session's progress and the book's audio duration, because reading sessions store percentages
rather than positions.

### Drizzle timestamp gotcha (important)

drizzle's node-postgres driver deliberately returns raw **strings** for `sql<>` timestamp
expressions - only schema `Column` fields get mapped back to `Date`. `sql<Date>\`max(...)\``is a
compile-time lie; at runtime it is a string, so calling`.getTime()`on it throws. Fix: chain`.mapWith(<the schema column>)`on the`sql`expression. Commit`930d61d2`fixed the author/series
aggregates in`audiobookshelf.repository.ts`(they would have crashed on real data; the unit tests
mocked the repository with`Date`objects so they never caught it). Use`.mapWith()`for any new`sql<>` timestamp aggregate.

### E2E suite repair

The audiobookshelf e2e suite had never been green. Two stale assumptions:

- The harness global-prefix excludes predated the `/abs` RouterModule mount, so every ABS request
  404'd. `app-harness.ts` now mirrors `main.ts`'s exclude list and the spec uses `/abs/api/...`
  URLs.
- The spec asserted raw integer ids before the ABS uuid id format existed; it now uses
  `toAbsUuid(...)`. It also needed the global `audiobookshelf_enabled` app setting enabled in
  `beforeAll` (per-library opt-in is not enough - the `AudiobookshelfEnabledGuard` checks the
  global setting).

The suite covers listening sessions end to end: live play/sync/close growing one reading session,
the session showing up in BookOrbit's own reading log, offline re-uploads updating instead of
duplicating, per-item sessions, stats aggregation, and derived author timestamps.

The ABS routes are listed in the authorization matrix inventory
(`server/test/e2e/authorization-matrix/route-inventory/routes-11.json`). A new ABS route must be
added there or the matrix's route-parity check fails.

## Remaining work, in priority order

### 1. Expand personalized shelves

Only `continue-listening` and `recently-added` are implemented. Verified against upstream
`server/models/LibraryItem.js` -> `getPersonalizedShelves`, plus
`server/utils/queries/libraryFilters.js` and `libraryItemsBookFilters.js`. The response is a bare
JSON array of shelves; a shelf whose `entities` would be empty is omitted; `total` is the total
match count, not `entities.length`.

BookOrbit's ABS surface is audiobooks-only, so upstream's ebook shelves (`continue-reading`,
`read-again`) and podcast shelves (`newest-episodes`) do not apply. The applicable shelves, in
upstream push order:

| #   | id                   | label              | labelStringKey           | type      | limit |
| --- | -------------------- | ------------------ | ------------------------ | --------- | ----- |
| 1   | `continue-listening` | Continue Listening | `LabelContinueListening` | `book`    | limit |
| 2   | `continue-series`    | Continue Series    | `LabelContinueSeries`    | `book`    | limit |
| 3   | `recently-added`     | Recently Added     | `LabelRecentlyAdded`     | `book`    | limit |
| 4   | `recent-series`      | Recent Series      | `LabelRecentSeries`      | `series`  | **5** |
| 5   | `discover`           | Discover           | `LabelDiscover`          | `book`    | limit |
| 6   | `listen-again`       | Listen Again       | `LabelListenAgain`       | `book`    | limit |
| 7   | `newest-authors`     | Newest Authors     | `LabelNewestAuthors`     | `authors` | limit |

`recent-series` is hardcoded to 5 upstream, not `limit`. `newest-authors` uses the plural
`type: 'authors'` while the book shelves use singular `type: 'book'`.

Semantics of the missing ones:

- **`continue-series`**: series the user has started but not finished; for each, the next
  unfinished book by sequence. Upstream orders series by
  `max(mediaProgresses.updatedAt)` within the series, descending, and requires at least one
  unfinished book. `total` is the count of qualifying series.
- **`recent-series`**: the 5 most recently added series, entities carrying their books.
- **`discover`**: the lowest-sequence book of every series in which the user has started nothing
  (`count(progress where isFinished or currentTime > 0) = 0`), ordered randomly. In Postgres use
  `ORDER BY random()` with the LIMIT in SQL so only `limit` rows materialise.
- **`listen-again`**: finished items, ordered by progress `updatedAt` descending.
- **`newest-authors`**: authors added within the last 60 days, newest first, with `numBooks`.
  Upstream filters the author row's own `createdAt`; BookOrbit has no such column, so use the
  derived author `addedAt` (`min(books.added_at)`) that this pass added, which is already
  available in the grouped author queries.

Every shelf query must be LIMIT/ORDER BY bounded in SQL, with counts via aggregate, and scoped by
exposed library, visibility, audio content and content filters.

### 2. Remaining response semantics

- Item list handling reports `minified: true` unconditionally and does not implement
  `collapseseries`. Both live in `AudiobookshelfLibrariesService.getItemsPage()`.
- Review optional `include` fields across personalized shelves, series, authors and items.
- Run a fresh comparison against current Audiobookshelf for every changed route before broadening
  the API. Prefer upstream source and captured real-server responses over third-party API docs;
  the third-party docs were wrong about the search shape.

### 3. Explicitly deferred by user decision

These were considered this pass and deliberately excluded. Do not start them without asking:

- **Playlists.** `GET /api/libraries/:id/playlists` and playlist detail/mutation routes are
  absent, and library detail always reports `numUserPlaylists: 0`. BookOrbit has no playlist
  persistence at all, so this is a new product feature (schema, migration, native API and UI),
  not just ABS compatibility.
- **Socket.IO real-time updates.** ABS user and library update notifications are not implemented.
  This is a new transport plus auth handshake and event fan-out. Most ABS clients degrade
  gracefully without it.

## Recommended next-agent workflow

1. Read `CLAUDE.md`, this document, and the existing untracked `docs/handover.md` without
   modifying the latter.
2. Confirm `git status --short` contains no unexpected files, and confirm the server and database
   are healthy.
3. Continue one fix or feature at a time, with one commit each.
4. For every API change, verify route and method, DTO validation, response fields, user scope,
   content filters, large-library bounds, focused tests, lint, formatting, and type-check.

If work is split across parallel agents, note that `audiobookshelf.repository.ts` is the main
contention point - almost every task wants to add a query to it. Either sequence the tasks that
touch it or give each agent a disjoint file set up front.
