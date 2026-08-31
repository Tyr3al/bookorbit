# Audiobookshelf-compatible API for Prologue

> **Implementation status (2026-08-31):** Phases 1-8 implemented (OAuth2/OpenID mobile flow
> shipped, ahead of the original plan; phase 9 stretch items still not started). The whole API
> surface was moved from the bare server root to a dedicated `/abs` path prefix, and a global
> admin toggle now gates the entire surface as an experimental feature. See "Implementation log",
> "Live compatibility fixes" and "The `/abs` path prefix" sections below.

BookOrbit will expose an Audiobookshelf-compatible HTTP API so the Prologue iOS app can use a
BookOrbit instance as its audiobook server. Prologue treats the server as an Audiobookshelf
instance and hardcodes the native Audiobookshelf paths (`/login`, `/api/...`), so BookOrbit must
serve those exact paths, not a path under `/api/v1`.

Decisions confirmed with the user:

- Login: username/password (`POST /login`) in phase 1; the OAuth2/OpenID mobile flow
  (`/auth/openid` PKCE) as a later phase, since Prologue supports both.
- Token: a dedicated long-lived access token (`JWT_ABS_EXPIRES_IN`, default 30 days), same JWT
  claims as the web token so the existing auth stack validates it unchanged.
- Library exposure: per-library opt-in toggle (new `libraries.enableAudiobookshelfApi` column).
- Phase 1 scope includes reading-progress read (mediaProgress) and write-back
  (`PATCH /api/me/progress/:libraryItemId`).

## Why this fits BookOrbit

BookOrbit already has most of the pieces:

- Audio is first-class: `book_files.durationSeconds` (`db/schema/books.ts:86`), audio format
  priority (`db/schema/libraries.ts:40`), `isAudioFormat()` (`modules/scanner/lib/classify.ts:4`),
  per-file duration probing and merged audio chapters (`book_metadata.chapters`, `modules/metadata/`).
- Audio playback position is stored per user in `audiobookProgress` (`db/schema/reader.ts:305`),
  with `getAudioProgress`/`saveAudioProgress` in `book.service.ts:2042-2047`.
- Range streaming for any file format already exists at `GET /books/files/:fileId/serve`
  (`book.controller.ts:391-427`) and download at `GET /books/files/:fileId/download`
  (`book.controller.ts:429-456`), both backed by the user-scoped `bookService.getFileInfo()`
  (`book.service.ts:1411`).
- The JWT strategy already extracts `Authorization: Bearer <token>` (`auth/jwt.strategy.ts:15`),
  so the global `JwtAuthGuard` works for an app that sends bearer tokens instead of cookies.
- The global `LibraryAccessGuard` (`common/guards/library-access.guard.ts`) already enforces
  user-to-library access on any route whose `:id` param is a library id.
- The Kobo module (`modules/kobo/`) is a proven template for an external-app-facing API with its
  own controllers, guards, and services.
- The migration connector (`modules/migration/adapters/audiobookshelf/`) already models the ABS
  data shapes (users, library items, books, media progress), useful as a shape reference.
- The OIDC client infrastructure exists (`modules/auth/oidc/`, `/auth/oidc/:slug/...`) for the
  later OpenID login phase.

## Compatibility surface

All payloads use ABS conventions: camelCase field names, epoch-millisecond integer timestamps,
string ids. Prologue is closed source, so this endpoint list is a high-confidence inference from
the ABS API spec and Prologue's issue tracker, not a code-verified client call list. Verify early
against a real Prologue install.

### Phase 1 endpoints

| Method | Path                                                          | Purpose                                                                  |
| ------ | ------------------------------------------------------------- | ------------------------------------------------------------------------ |
| POST   | `/login`                                                      | Password login; returns ABS-shaped user with `token` and `mediaProgress` |
| GET    | `/api/authorize`                                              | Validate a persisted token; returns the user payload                     |
| GET    | `/api/me`                                                     | Current user                                                             |
| GET    | `/api/me/progress/:libraryItemId/:episodeId?`                 | Read mediaProgress                                                       |
| PATCH  | `/api/me/progress/:libraryItemId/:episodeId?`                 | Write mediaProgress                                                      |
| GET    | `/api/libraries`                                              | Accessible libraries (ABS `mediaType: "book"`)                           |
| GET    | `/api/libraries/:id/items?limit=&page=&sort=&filter=&search=` | Paginated items                                                          |
| GET    | `/api/libraries/:id/authors`                                  | Authors with book counts                                                 |
| GET    | `/api/libraries/:id/series`                                   | Series list                                                              |
| GET    | `/api/libraries/:id/series/:seriesId`                         | One series                                                               |
| GET    | `/api/libraries/:id/search?q=`                                | Stretch goal (Prologue filters locally)                                  |
| GET    | `/api/items/:id?expanded=1&include=progress`                  | One LibraryItem                                                          |
| GET    | `/api/items/:id/cover`                                        | Cover image bytes                                                        |
| GET    | `/api/items/:id/download`                                     | Audio file bytes; zip for multi-file books; Range-capable                |
| GET    | `/api/items/:id/file/:fileId`                                 | Single audio file bytes; Range-capable                                   |
| GET    | `/api/authors/:id?include=items,series`                       | Author with `libraryItems[]` and `series[]`                              |
| GET    | `/api/series/:id`                                             | One series                                                               |
| GET    | `/api/collections`                                            | User's collections                                                       |
| GET    | `/api/collections/:id`                                        | Collection with embedded `books[]`                                       |

### Later phases

- ~~`GET /auth/openid?...` + `GET /auth/openid/mobile-redirect?token=...&state=...` (PKCE S256) for
  Prologue's OAuth2 add-server flow.~~ Implemented (phase 8) - see "Implementation log".
- `GET /api/libraries/:id/search?q=`.
- Optional: accept `?token=` on GETs (ABS allows it; only add if Prologue turns out to use it).

## Design

### Routing

> **Superseded 2026-08-31**: the API no longer lives at the bare server root - it's mounted under
> `/abs` instead. See "The `/abs` path prefix" near the end of this document for why and how. The
> design below (root-level routes via global-prefix exclusion) is left as-is for history; the
> exclusion-list mechanism it describes is still how `/abs/*` is carved out of the `/api/v1`
> prefix, just with an `abs/` prefix added to every excluded path.

Register the native paths by extending the global-prefix exclusions in `main.ts:64-66`:

```ts
app.setGlobalPrefix("api/v1", {
  exclude: [
    "api/kobo/:deviceToken/(.*)",
    "api/v3/(.*)",
    "api/UserStorage/(.*)",
    "login",
    "api/(.*)",
  ],
});
```

NestJS matches exclude patterns against the route path before the global prefix is applied
(`route-path-factory.ts`), so a controller declared as `@Controller('api/libraries')` matches the
`api/(.*)` exclusion and is served at `/api/libraries`. No existing controller uses an `api/` or
`login` path prefix, so there is no collision. (The existing `api/kobo/...`, `api/v3/...`,
`api/UserStorage/...` entries are vestigial and match nothing today; leave them or clean them up.)

Controllers in the new module:

- `@Controller('login')` - `POST /`
- `@Controller('api/authorize')` - `GET /`
- `@Controller('api/me')` - `GET /`, `GET|PATCH /progress/:libraryItemId/:episodeId?`
- `@Controller('api/libraries')` - `GET /`, `GET /:id/items`, `GET /:id/authors`, `GET /:id/series`,
  `GET /:id/series/:seriesId`, `GET /:id/search`
- `@Controller('api/items')` - `GET /:id`, `GET /:id/cover`, `GET /:id/download`, `GET /:id/file/:fileId`
- `@Controller('api/authors')` - `GET /:id`
- `@Controller('api/series')` - `GET /:id`
- `@Controller('api/collections')` - `GET /`, `GET /:id`

### Authentication and tokens

The ABS controllers are not `@Public()`; they fall under the global `JwtAuthGuard`,
`PermissionGuard`, and `LibraryAccessGuard`. Prologue sends the token as `Authorization: Bearer`,
which the existing `JwtStrategy` already accepts, and `@CurrentUser()`/`RequestUser` work unchanged.

`POST /login` reuses the existing login flow in `auth.service.ts` (`login()` at line 225 already
returns `{ accessToken, user }`) but signs the access token with a longer TTL:

- Add `auth.jwtAbsExpiresIn` to the `auth` config (`server/src/config/config.ts`,
  `env.validation.ts`), sourced from `JWT_ABS_EXPIRES_IN` (default `30d`).
- Add `AuthService.loginForAudiobookshelf(dto, reply, ip)` that shares the existing validation,
  lockout, audit, and refresh-rotation logic and issues the token via
  `jwtService.sign({ sub, ver }, { expiresIn: jwtAbsExpiresIn })`. Keep the claims identical to the
  web token so the same `validateUser(payload.sub, payload.ver)` path validates both; revocation
  (password change, logout-all) bumps `tokenVersion` and invalidates both token kinds.
- Response shape: `{ user, userDefaultLibraryId, serverSettings, Source }` where
  `user = { id, username, type, token, mediaProgress, permissions, settings, isActive, isLocked,
lastSeen, createdAt, updatedAt, itemTags, tags, libraries }`. Map `type` from `isSuperuser`
  (`root`/`admin` vs `user`) and `permissions` from the BookOrbit permission set (at minimum
  `download`, `update`, `delete`, `upload`, `accessAllLibraries`).
- `mediaProgress` is derived from `audiobookProgress` for every audio book the user can access
  (see Progress below).

Security notes:

- A 30-day bearer token is a larger surface than the 15-minute web token. It is opt-in in the
  sense that it is only issued by the ABS login endpoint and only libraries opted in are visible;
  document this in the env example and release notes.
- Do not log the token. Reuse the existing `sanitizeLogValue()` discipline for any dynamic log
  values and keep the login audit events (`AuditAction.AuthLogin`).

### Library exposure

Add a per-library opt-in toggle:

- New column `libraries.enableAudiobookshelfApi boolean notNull default false`
  (`db/schema/libraries.ts`), generated via `pnpm db:generate` + `pnpm db:migrate`.
- Toggle in the client library settings UI (`client/src/features/library/components/LibraryCreator*`).
- `GET /api/libraries` lists only libraries where the flag is set AND the user has access, reusing
  the user-scoped library query pattern in `library.repository.ts:48/70` (which joins
  `userLibraryAccess`). Map to ABS `Library`: `{ id, name, folders, displayOrder, icon,
mediaType: "book", provider, settings, createdAt, lastUpdate }`.
- `GET /api/libraries/:id/items` returns only books that have at least one audio file
  (`role = 'content'` and format in the scanner `AUDIO_FORMATS` set: m4b, mp3, m4a, opus, ogg,
  flac). Prologue cannot play ebooks, so non-audio books are hidden entirely, including from
  authors, series, and collections.

### Identity mapping

| ABS concept                     | BookOrbit source                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| library id                      | `libraries.id` (stringified)                                                                                                                                                                                                                                                                                                                                                |
| libraryItem id                  | `books.id` (stringified)                                                                                                                                                                                                                                                                                                                                                    |
| file id (`/file/:fileId`)       | `book_files.id`                                                                                                                                                                                                                                                                                                                                                             |
| mediaType                       | `"book"` (podcasts are out of scope)                                                                                                                                                                                                                                                                                                                                        |
| media.metadata.authors          | `authors` via `bookAuthors` (`displayOrder`)                                                                                                                                                                                                                                                                                                                                |
| media.metadata.narrators        | `narrators` via `bookNarrators`                                                                                                                                                                                                                                                                                                                                             |
| media.metadata.series           | `series` via `bookSeriesMemberships` (`seriesIndex`); plus denormalized `book_metadata.seriesId/seriesName/seriesIndex`                                                                                                                                                                                                                                                     |
| media.audioFiles / media.tracks | audio `book_files` ordered by `sortOrder`; `contentUrl = /api/items/{bookId}/file/{fileId}`                                                                                                                                                                                                                                                                                 |
| media.chapters                  | `book_metadata.chapters` jsonb (already merged per-file; map to `{ id, start, end, title }`)                                                                                                                                                                                                                                                                                |
| media.duration                  | `book_metadata.durationSeconds` (fallback: sum of file durations)                                                                                                                                                                                                                                                                                                           |
| addedAt/updatedAt               | `books.addedAt` / `books.updatedAt` as epoch ms                                                                                                                                                                                                                                                                                                                             |
| isFile                          | `true` when the book has exactly one audio file                                                                                                                                                                                                                                                                                                                             |
| isMissing                       | `books.status = 'missing'`                                                                                                                                                                                                                                                                                                                                                  |
| coverPath                       | non-null placeholder (`/metadata/items/{id}/cover.jpg`) when `book_metadata.cover_source` is set, else null; covers are always served by `GET /api/items/:id/cover` regardless of this value's content - see "Live compatibility fixes" (real ABS clients treat a null coverPath as "no cover" and skip fetching one, even though they never actually use the literal path) |

`track.startOffset` is the cumulative duration of preceding audio files, so Prologue can position
correctly in multi-file books.

### Streaming and download

- `GET /api/items/:id/file/:fileId` and `GET /api/items/:id/download`: reuse
  `bookService.getFileInfo(fileId, user)` (`book.service.ts:1411`), which verifies file ownership,
  then serve with the exact Range/206 logic already in `book.controller.ts:391-427`
  (`Accept-Ranges: bytes`, 206 + `Content-Range`/`Content-Length`, 416 handling). Extract that
  small range handler into a shared helper (e.g. `common/utils/range-stream.utils.ts`) used by both
  the book controller and the ABS controllers, so behavior stays identical.
- MIME types from the existing `AUDIO_MIME_TYPES` map (`book.controller.ts:62`).
- `Content-Disposition`: `inline` for `/file`, `attachment` for `/download`.
- Multi-file download: `/download` zips the audio files in track order. Stream the zip with bounded
  memory (reuse an existing archive helper if one exists; otherwise add a streaming zip writer and
  unit-test it). Phase 1 can ship single-file `/download` first and add the zip in the same phase.
- Access control: `getFileInfo` + `LibraryAccessGuard` (the `:id` in `/api/libraries/:id/items`
  routes is the library id, so the guard applies; `items` controller routes must not use
  `@RequireLibraryAccess` since their `:id` is a book id).

### Progress

- Read: `mediaProgress` derived from `audiobookProgress` (`reader.ts:305`):
  `{ id, libraryItemId, mediaItemId, mediaItemType: "book", duration, progress, currentTime,
isFinished, startedAt, lastUpdate, createdAt, updatedAt, ebookLocation: null, ebookProgress: null }`.
  `progress = percentage / 100`; `currentTime` = absolute book position (sum of preceding file
  durations + `positionSeconds`); `isFinished` from the library's
  `markAsFinishedPercentComplete` threshold or the book status.
- Include `mediaProgress` in the `POST /login`, `GET /api/authorize`, and `GET /api/me` responses,
  and honor `include=progress` on `GET /api/items/:id`.
- Write-back: `PATCH /api/me/progress/:libraryItemId/:episodeId?` maps the ABS position back to
  `audiobookProgress` (resolve `currentFileId` by walking track offsets) by calling
  `bookService.saveAudioProgress()` (`book.service.ts:2047`) or the `reading-state` repository,
  after reusing the same access checks. Ignore `episodeId` (no podcasts).

### Scale expectations

- `GET /api/libraries/:id/items` must be offset-paginated (`limit`/`page`, Prologue requests
  `limit=10`) with a total count; reuse the `bookRepo.findCards`-style LIMIT/OFFSET query shape
  (`book.repository.ts:542`) with an audio-format filter and `userLibraryAccess` join. Never load a
  whole library into memory.
- mediaProgress enumeration on login must be a single batched query per user, not an N+1 loop over
  every book.
- Cover and stream responses stream from disk; no buffering of large files.

## Module structure

New module `server/src/modules/audiobookshelf/` (mirrors the Kobo module layout), registered in
`app.module.ts`:

```
modules/audiobookshelf/
  audiobookshelf.module.ts
  controllers/
    login.controller.ts
    authorize.controller.ts
    me.controller.ts
    libraries.controller.ts
    items.controller.ts
    authors.controller.ts
    series.controller.ts
    collections.controller.ts
  services/
    audiobookshelf-auth.service.ts   # ABS-shaped login response, token issuance
    library-item.mapper.service.ts   # Book + audio files -> ABS LibraryItem
    libraries.service.ts             # library list + paginated items
    items.service.ts                 # item detail, cover, file access resolution
    stream.service.ts                # Range streaming + download/zip
    authors.service.ts
    series.service.ts
    collections.service.ts
    progress.service.ts              # mediaProgress read/write
```

Shared types live in `packages/types` (imported as `@bookorbit/types`), e.g. an
`AudiobookshelfLibraryItem` interface used by the mapper and its tests.

## Implementation phases

1. **Skeleton and schema**: add `libraries.enableAudiobookshelfApi` (migrate), add
   `JWT_ABS_EXPIRES_IN` to auth config/env validation, add `login`/`api/(.*)` prefix exclusions,
   create the module with empty controllers and guards wired, register in `app.module.ts`. Verify:
   `pnpm db:generate`, `pnpm db:migrate`, server boots, existing e2e suites still pass
   (authorization-matrix route inventory needs the new ABS routes added to its route inventory
   JSON, like `routes-04.json` does for kobo).
2. **Auth**: `POST /login`, `GET /api/authorize`, `GET /api/me` with ABS-shaped user,
   `mediaProgress`, and long-lived token. Verify with unit tests plus an e2e login→authorize→me
   flow.
3. **Libraries and items**: `GET /api/libraries`, `GET /api/libraries/:id/items` (paginated),
   `GET /api/items/:id` (+ `include=progress`), and the `LibraryItem` mapper. Verify pagination
   with a seeded multi-hundred-book library in e2e; assert non-audio books and non-opted-in
   libraries never appear; assert cross-user isolation.
4. **Stream, download, cover**: `GET /api/items/:id/file/:fileId`, `/download` (single file + zip),
   `/cover`. Verify Range/206 behavior with a real audio file over HTTP and resume-after-seek
   behavior (this is what AVPlayer depends on).
5. **Authors, series, collections**: the four listing/detail endpoints, filtered to opted-in
   libraries and audio books, user-scoped.
6. **Progress write-back**: `PATCH /api/me/progress/:libraryItemId`, plus read-side wiring from
   step 2. Verify round-trip: PATCH a position, GET `/api/me` and see it in mediaProgress, then
   verify the BookOrbit UI shows the same position.
7. **Client toggle**: library settings UI checkbox for `enableAudiobookshelfApi`
   (`client/src/features/library/components/LibraryCreator*`).
8. **OAuth2/OpenID mobile flow** (Prologue's other login path): implement
   `GET /auth/openid` (PKCE S256) and `GET /auth/openid/mobile-redirect?token=&state=` reusing the
   existing OIDC infrastructure (`modules/auth/oidc/`). Investigate first how Prologue drives the
   flow before committing to a shape.
9. **Stretch**: `/api/libraries/:id/search?q=`, `?token=` query auth, ABS playback-session
   reporting, `mediaType: "podcast"`.

## Testing

- Vitest unit tests (`*.test.ts`) for the mapper (Book row -> LibraryItem), the progress
  conversion (position <-> currentFileId/offset), and the range/zip streaming helpers.
- E2E specs under `server/test/` following the kobo e2e patterns: login flow, paginated items,
  streaming Range requests, author/series/collection shapes, progress round-trip, and an
  authorization matrix extension asserting library isolation and 401s with bad tokens.
- Manual verification checklist with a real Prologue install: add server (URL + username +
  password), browse library, open a book, seek, download for offline, resume across restarts,
  check author/series/collection shelves.

## Risks and open questions

- ~~Prologue is closed source; the exact endpoint call list cannot be verified from code.~~
  Resolved for the surface actually exercised so far: live-tested end to end with a real Prologue
  install, using Prologue's own exportable debug logs (gave exact Swift `DecodingError` paths) and
  a real Audiobookshelf server in a debug Docker container for byte-level response comparison when
  a bug's cause wasn't obvious from the server side alone (that combination found the collections
  minified-vs-full-item bug and the coverPath null-vs-placeholder bug - both would have been very
  hard to find by code inspection). Untested surface (search, playback-session reporting, other
  ABS clients like Plappa) should still be treated as unverified.
- ~~If Prologue refuses username/password and insists on the OpenID flow, phase 8 becomes
  phase 2.~~ Resolved: phase 8 (OAuth2/OpenID mobile flow) is implemented; Prologue's
  password-login path also works and was the one used for most testing.
- ~~`book_metadata.chapters` shape must be confirmed against ABS
  `chapters[{id,start,end,title}]`.~~ Resolved, with a caveat: real ABS's scanner also synthesizes
  one chapter per audio file when there's no explicit chapter metadata (BookOrbit's scanner
  usually has none) - `mapChapters()` now does the same rather than ever returning an empty list.
- Multi-file `/download` zip needs a streaming writer; verify memory behavior on large books. Not
  re-verified during the live testing pass above (testing used small fixture books).
- The `/abs` path-prefix move (see "The `/abs` path prefix") assumes ABS-ecosystem clients accept
  a path suffix in the configured server address, based on real Audiobookshelf's own
  `ROUTER_BASE_PATH` reverse-proxy support and confirmed working with Prologue - but this is a
  BookOrbit-specific deployment choice, not part of the ABS spec itself, so a different ABS client
  that hardcodes an origin-only (no-path) server address would break. No such client has been
  identified yet.
- The master enable/disable switch defaults to _off_, unlike OPDS's `opds_enabled` (which defaults
  to _on_) - deliberate, since this integration is still labeled experimental in the UI. Revisit
  the default once the integration is no longer experimental.

## Implementation log

Phases 1-7 of the plan above are implemented:

1. **Skeleton and schema**: `libraries.enable_audiobookshelf_api` column (migration 0082),
   `auth.jwtAbsExpiresIn` config (`JWT_ABS_EXPIRES_IN`, default 30d), `login`/`api/(.*)` global
   prefix exclusions in `main.ts`, `AudiobookshelfModule` registered in `app.module.ts`.
2. **Auth**: `AuthService.loginForAudiobookshelf()` (shares credential validation, lockout, and
   audit with the web login; signs the token with the ABS TTL). `POST /login`,
   `GET /api/authorize`, `GET /api/me` with ABS-shaped users, permissions, and mediaProgress.
3. **Libraries and items**: `GET /api/libraries`, `GET /api/libraries/:id/items` (offset
   pagination, sort, title search), `GET /api/items/:id`, `GET /api/libraries/:id/search`, and
   the `LibraryItem` mapper (tracks with cumulative start offsets, chapters, audioFiles).
4. **Stream, download, cover**: `GET /api/items/:id/file/:fileId` and `/download` (Range/206
   support via the new shared `sendFileStream` helper in `common/utils/range-stream.utils.ts`,
   which `book.controller.ts` now also uses), zip for multi-file downloads, `GET /api/items/:id/cover`.
5. **Authors, series, collections**: the four listing/detail endpoints, scoped to opted-in
   libraries and audio books, user-scoped.
6. **Progress**: mediaProgress read (login/authorize/me, `include=progress` via item detail is
   implicit) and `PATCH /api/me/progress/:libraryItemId` write-back to `audiobook_progress`.
7. **Client toggle**: new "Integration" section in the library creator modal with the
   Audiobookshelf API toggle, plus `enableAudiobookshelfApi` on the shared `Library` type and the
   create/update library DTOs.

8. **OAuth2/OpenID mobile flow**: `AbsOAuthController` (`@Controller('auth/openid')`, `@Public()`)
   implements the mobile add-server flow Prologue's "Sign In" uses: `GET /auth/openid` (validates
   a custom-scheme `redirect_uri` + PKCE `code_challenge`, redirects to a login page), a small
   server-rendered login form at `GET|POST /auth/openid/login` (BookOrbit acts as its own identity
   provider - the form authenticates against regular BookOrbit accounts, no external OIDC
   provider involved), and `GET /auth/openid/mobile-redirect` which forwards `code` (a BookOrbit
   access token) + `state` back to the app's custom scheme. State is tracked in-memory via
   `AbsOAuthStateStore`. Also added in this phase: `POST /auth/refresh` (rotates the token pair
   from the `x-refresh-token` header; registered as a raw Fastify route via
   `AbsRefreshRouteRegistrar` rather than a Nest controller route - see "The `/abs` path prefix"
   for why) and `PATCH /api/me/progress/batch/update` (bulk progress sync, tolerant of per-item
   failure like real ABS).

Not yet done: phase 9 stretch items (`GET /api/libraries/:id/search?q=` is implemented but
`?token=` query auth, podcast mediaType, and playback-session reporting are not - `GET
/api/me/item/listening-sessions/:libraryItemId` returns an empty session list rather than real
history). The authorization-matrix route inventory was not extended: it only tracks `/api/v1`
routes, and the ABS API intentionally lives outside that prefix.

Verification: server unit tests, `test/audiobookshelf-api.e2e-spec.ts` (24 tests, registered as
the `audiobookshelf-api` e2e suite in `scripts/e2e/suite-registry.mjs`), client library tests,
typecheck and lint for both workspaces.

## Live compatibility fixes (2026-08-31)

Phases 1-7 above were built against the ABS API spec without a real client to test against. Once
tested live with the real Prologue iOS app - and, for several of the harder bugs, byte-level
comparison against a real Audiobookshelf server running in a debug Docker container - numerous
shape and behavior mismatches surfaced. None of these were caught by the e2e suite because they
depend on exact client-side (Swift `Codable`) decoding behavior, not just "does the server return
200". Findings, in the order they were hit:

- **Sign-in "unknown error"**: `serverSettings.metadataFileFormat` was an empty string; real ABS
  clients decode several `serverSettings` fields more strictly than a generic JSON blob would
  suggest. Fixed alongside several other `serverSettings`/`authFormData` field value/type
  mismatches (see `status.controller.ts`).
- **"Unable to fetch libraries"**: `library.provider` was `'bookorbit'`, not a value from ABS's
  fixed metadata-provider enum (`google`, `itunes`, `openlibrary`, `audible`, ...) - some ABS
  clients model this as a strict enum and fail to decode an unrecognized value. Now hardcoded to
  `ABS_PROVIDER = 'google'` (cosmetic only; BookOrbit doesn't call `google` for real).
  `library.settings.metadataPrecedence` had the same problem (BookOrbit's own metadata-source
  vocabulary, not ABS's fixed six-value list) - fixed by using the exact real ABS default via
  `ABS_METADATA_PRECEDENCE` instead of translating BookOrbit's own values.
- **Non-integer id crash (`NaN`) on any route with a UUID-shaped `:id` param**: NestJS/Fastify
  pre-coerces a `@Param()` whose method-parameter type is `number` by running `Number(value)`
  _before_ any custom param-level pipe runs, silently turning a UUID string into `NaN`. Every ABS
  controller route now takes the id param as a raw `string` and calls the plain function
  `parseAbsId()` (`pipes/abs-id.pipe.ts`) inline - not a `PipeTransform` class, since that's what
  triggers the type-inference coercion in the first place.
- **Chapters tab crash**: chapters were only mapped from explicit `book_metadata.chapters`, which
  is empty for most scanned books. Real ABS's scanner always synthesizes one chapter per audio
  file (titled from the filename) when there's no explicit chapter metadata - BookOrbit's mapper
  now does the same (`mapChapters()` in `library-item-mapper.service.ts`). Also, `AbsAudioFile`/
  `AbsTrack` were missing many fields real ABS's client model requires as non-optional
  (`bitRate`, `codec`, `timeBase`, `channels`, `channelLayout`, `trackNumFromFilename`, ...) -
  BookOrbit doesn't probe these from its own scan, so they're now best-effort estimates rather
  than omitted.
- **Playback 404**: Prologue builds its own file-content URL from `audioFile.ino`, not from the
  `contentUrl` the server hands back. `resolveFile()` in `audiobookshelf-items.service.ts` now
  falls back to matching an incoming plain-integer `fileId` against the book's file `ino` values
  when it isn't one of BookOrbit's own file ids.
- **Minified vs. full item shapes**: real ABS uses a leaner `LibraryItemMinified` shape (no
  `audioFiles`/`tracks`/`chapters`/per-author-id arrays) for list/search endpoints, and the full
  expanded shape only for `GET /api/items/:id`. BookOrbit originally used the full shape
  everywhere; `LibraryItemMapperService.toLibraryItemMinified()` and
  `AudiobookshelfItemsService.getMinifiedItemsByIds()` now provide the leaner shape where real ABS
  does. **Important exception found later**: `GET /api/collections` and
  `GET /api/libraries/:id/collections` embed **full** expanded items in `books[]`, not minified
  ones, confirmed by diffing against a real ABS server - using the minified shape there caused
  Prologue to silently decode the collections list as empty (no visible error), which is why
  `AudiobookshelfCollectionsService.hydrate()` calls `getItemsByIds()`, not
  `getMinifiedItemsByIds()`.
- **Cover art not appearing despite the server returning 200 with valid image bytes**:
  `media.coverPath` was hardcoded to `null` always, on the theory that only `GET
/api/items/:id/cover` actually matters for fetching bytes (still true). But real ABS clients
  appear to treat a `null` coverPath as "no cover, don't bother fetching" and skip calling the
  cover endpoint entirely - confirmed once a full Prologue reinstall ruled out client-side
  caching. Fixed by populating `coverPath` with a non-null placeholder whenever
  `book_metadata.cover_source` is set (its literal value doesn't matter to the client).
- **Author "Jane is assigned to every book"**: `GET /api/libraries/:id/items` never parsed the
  `filter` query parameter at all - `filter=authors.<base64-uuid>` and `filter=missing.authors`
  were both silently ignored, so every filtered request returned the full unfiltered list. Fixed
  by `common/utils/abs-filter.utils.ts` (`parseAbsItemFilter()`) plus SQL clause building in
  `AudiobookshelfRepository.buildAbsFilterClause()`, supporting `authors`, `series`, `narrators`,
  `genres`, `publishers`, `languages`, and `missing.<field>`. Note: **every** filter category is
  base64-encoded, including `missing.*` (`missing.authors` arrives as
  `filter=missing.YXV0aG9ycw==`) - it is not just the entity-id categories, which was the wrong
  assumption on the first pass.
- **`AbsCollection` missing `libraryId`, wrong timestamp field names**: real ABS's `Collection`
  model has `libraryId`, `createdAt`, and `lastUpdate` - BookOrbit's had no `libraryId` and used
  `addedAt`/`updatedAt`. Since BookOrbit's own collections are user-scoped, not library-scoped,
  `libraryId` is derived from the collection's own books' library (or the user's first exposed
  library for an empty collection) rather than stored directly.
- **A genuine `groupItemsBySeries` 500 crash**: a regression from the minified-item-shape
  migration above - the code read `item.media.metadata.series`, which no longer exists on the
  minified shape. Fixed by querying series membership from the repository directly instead of
  parsing it off the (now-incomplete) mapped item.

## The `/abs` path prefix

Originally the whole API lived at the bare server root (`/login`, `/status`, `/api/...`, excluded
from the `/api/v1` global prefix) because Prologue hardcodes those exact ABS paths relative to
whatever "Server Address" the user enters. That collided with BookOrbit's own web client: hitting
`http://host:3000/` in a browser got a placeholder Audiobookshelf marker page (added so real ABS
clients could detect the server by probing root) instead of BookOrbit's UI, or a 404, depending on
environment - `pnpm dev`'s client dev server runs on its own port (5173) and was never meant to be
reachable through 3000 at all, but the placeholder page made that confusing rather than obvious.

The whole `AudiobookshelfModule` now mounts under `/abs` via `RouterModule.register([{ path:
'abs', module: AudiobookshelfModule }])` in `app.module.ts` (the same way an OPDS feed lives at
its own subpath), so the user points Prologue's "Server Address" at `http://host:3000/abs`
instead of the bare host. This mirrors a pattern real Audiobookshelf itself supports for
reverse-proxy deployments (`ROUTER_BASE_PATH`), so ABS-ecosystem clients are expected to tolerate
a path suffix in the server address - confirmed working with Prologue after the migration.

Consequences of the move, all fixed:

- The global-prefix exclude list in `main.ts` and the (temporary) diagnostic header-strip hook's
  path list both had to change from bare paths (`login`, `/login`) to `abs`-prefixed ones
  (`abs/login`, `/abs/login`).
- Several hardcoded _absolute_ paths inside handler bodies don't get rewritten by
  `RouterModule`'s prefixing (it only affects incoming route matching, not outgoing
  redirects/URLs written in code) - these all needed a literal `${ABS_BASE_PATH}` prefix added:
  the three `reply.redirect(...)` calls and the login-form `action` attribute in
  `abs-oauth.controller.ts`, the raw Fastify path in `abs-refresh-route.registrar.ts`, and
  `track.contentUrl` in `library-item-mapper.service.ts`.
- The root-probe marker-page fallback in `main.ts` is now scoped to unmatched paths under
  `/abs/*` only (in every environment, fixing a latent bug where production would have served
  BookOrbit's own SPA there instead of the ABS marker). Bare root `/` and other unmatched paths in
  dev now correctly 404 instead of showing the placeholder page.
- `AbsRefreshRouteRegistrar`'s raw-Fastify-route hack (needed because `/auth/refresh` used to
  collide with the web app's own `auth/refresh` route at the literal Nest-path level, before the
  `/abs` prefix existed) is no longer strictly necessary for that reason, but was left as-is since
  it still works and needs no DTO/pipe machinery - see the comment in that file if revisiting.

## Master enable/disable switch (2026-08-31)

Added a global admin toggle, independent of the existing per-library `enableAudiobookshelfApi`
opt-in, since the feature is explicitly experimental:

- `app_settings` key `audiobookshelf_enabled` (seeded `false` by default - opt-in, unlike OPDS
  which defaults on), `AppSettingsService.isAudiobookshelfEnabled()`, and
  `AudiobookshelfEnabledGuard` (mirrors `OpdsEnabledGuard`), applied via `@UseGuards(...)` to
  every one of the module's 11 controllers plus a manual check inside
  `AbsRefreshRouteRegistrar` (which bypasses Nest's guard pipeline entirely as a raw Fastify
  route). When disabled, the entire `/abs` surface - including `/abs/login`, `/abs/status`,
  `/abs/ping` - returns 403, not just the data endpoints.
- Admin UI: a new "Audiobookshelf" settings page directly under OPDS in the settings nav
  (`client/src/features/settings/AudiobookshelfSettings.vue`, gated by the
  `manage_app_settings` permission), with an enable/disable toggle, the endpoint URL
  (`{origin}/abs`) with a copy button, an "Experimental" badge next to the feature name, and a
  notes panel pointing out that individual libraries still need their own opt-in toggle to
  actually appear through the endpoint once the master switch is on.
