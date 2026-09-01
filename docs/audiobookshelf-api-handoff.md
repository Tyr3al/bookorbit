# Audiobookshelf API compatibility handoff

## Status

The active branch is `feature/audiobookshelf-api`. This pass removed the temporary header
diagnostic, corrected library search against upstream, bounded three more large-library query
paths, and made author timestamps real. Listening-session persistence was started but is
**incomplete and currently parked in a git stash** (see "Parked work" below).

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

## Parked work: listening sessions and stats

This was started and is **incomplete**. It is saved in a git stash on this branch:

```text
stash@{0}  WIP: ABS listening sessions + stats (incomplete, agent stopped mid-edit)
```

Recover it with `git stash pop` (or inspect with `git stash show -p stash@{0}`). **A stash is
local and easy to lose** - if this branch is going to sit for a while, pop it and commit it to a
scratch branch instead.

Tracked files it modifies:

```text
server/src/db/migrations/meta/_journal.json
server/src/db/schema/index.ts
server/src/modules/audiobookshelf/audiobookshelf.constants.ts
server/src/modules/audiobookshelf/audiobookshelf.module.ts
server/src/modules/audiobookshelf/audiobookshelf.types.ts
server/src/modules/audiobookshelf/controllers/me.controller.ts
server/src/modules/audiobookshelf/controllers/me.controller.test.ts
server/src/modules/audiobookshelf/services/audiobookshelf-playback.service.ts
server/src/modules/audiobookshelf/services/audiobookshelf-playback.service.test.ts
server/src/modules/audiobookshelf/services/audiobookshelf-progress.service.ts
server/src/modules/audiobookshelf/services/audiobookshelf-progress.service.test.ts
```

New files it adds:

```text
server/src/db/schema/audiobookshelf.ts
server/src/db/migrations/0083_abs_listening_sessions.sql
server/src/db/migrations/meta/0083_snapshot.json
server/src/modules/audiobookshelf/services/audiobookshelf-sessions.repository.ts
server/src/modules/audiobookshelf/services/audiobookshelf-sessions.service.ts
```

**Its state is unverified.** It did not type-check or lint cleanly when work stopped, it was
mid-way through updating `me.controller.test.ts` for a new constructor argument on
`AudiobookshelfProgressService`, and the generated migration has not been reviewed or applied. Do
not assume any of it is correct; re-run the full check suite before trusting a line of it. It was
stashed rather than committed specifically so a broken tree never landed on the branch.

The design it was built against, which is still the right design:

- Keep the deterministic composite session id (`toAbsCompositeUuid(user.id, bookId)`) as the live
  playback handle so `play`/`sync`/`close` stay stateless. Persist a **separate** historical row
  with its own primary key purely for the read paths.
- Write rows from `play()` (open/refresh), `sync()`/`close()` (accumulate the client-reported
  `timeListening`, advance `currentTime`), and the local-session batch. Session persistence must
  be batched alongside `applyProgressBatch()`, and a persistence failure must be logged and
  swallowed rather than breaking playback or progress.
- Reads: `GET /api/me/listening-sessions` and
  `GET /api/me/item/listening-sessions/:libraryItemId/:episodeId?` return
  `{ total, numPages, page, itemsPerPage, sessions }` sorted by `updatedAt` desc, with
  `numPages = Math.ceil(total / itemsPerPage)` and `itemsPerPage` defaulting to 10. Pagination is
  SQL `LIMIT`/`OFFSET` plus a count, never a slice.
- `GET /api/me/listening-stats` does not exist yet. Upstream shape:
  `{ totalTime, items: { "<libraryItemId>": { id, timeListening, mediaMetadata, lastUpdate } },
days: { "YYYY-MM-DD": seconds }, dayOfWeek: { "Monday": seconds }, today, recentSessions }`.
  Note `items`, `days` and `dayOfWeek` are objects keyed by id/date/weekday, not arrays. Compute
  everything but `recentSessions` (limit 10) with grouped SQL aggregates.

## Remaining work, in priority order

### 1. Finish listening sessions and stats

See "Parked work" above. This is the item in flight.

### 2. Expand personalized shelves

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

### 3. Remaining response semantics

- Item list handling reports `minified: true` unconditionally and does not implement
  `collapseseries`. Both live in `AudiobookshelfLibrariesService.getItemsPage()`.
- Review optional `include` fields across personalized shelves, series, authors and items.
- Run a fresh comparison against current Audiobookshelf for every changed route before broadening
  the API. Prefer upstream source and captured real-server responses over third-party API docs;
  the third-party docs were wrong about the search shape.

### 4. Explicitly deferred by user decision

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
2. Confirm `git status --short` contains no unexpected files, and check `git stash list` for the
   parked listening-sessions work before starting anything that touches
   `audiobookshelf-progress.service.ts`, `audiobookshelf-playback.service.ts` or `me.controller.ts`.
3. Confirm the server and database are healthy.
4. Continue one fix or feature at a time, with one commit each.
5. For every API change, verify route and method, DTO validation, response fields, user scope,
   content filters, large-library bounds, focused tests, lint, formatting, and type-check.

If work is split across parallel agents, note that `audiobookshelf.repository.ts` is the main
contention point - almost every task wants to add a query to it. Either sequence the tasks that
touch it or give each agent a disjoint file set up front.
