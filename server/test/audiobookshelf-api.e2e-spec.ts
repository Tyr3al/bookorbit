import { hash } from 'bcryptjs';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createFixtureTree, file, type FixtureTree } from './e2e/scanner/scanner-fixture-builder';
import { ADMIN_SETUP_DTO, closeE2EContext, createE2EContext, seedLibrary, triggerAndWaitForLibraryScan, type E2EContext } from './e2e/app-harness';
import { toAudiobookshelfUuid } from '../src/common/utils/audiobookshelf-id.utils';
import {
  appSettings,
  authors,
  bookAuthors,
  bookMetadata,
  libraries,
  userLibraryAccess,
  userPermissions,
  users,
  collections,
  collectionBooks,
} from '../src/db/schema';

describe('Audiobookshelf-compatible API', () => {
  let ctx: E2EContext;
  let fixture: FixtureTree;
  let hiddenFixture: FixtureTree;
  let absLibraryId: number;
  let hiddenLibraryId: number;
  let bookOneId: number;
  let bookTwoId: number;
  let fileOneId: number;
  let fileTwoId: number;

  beforeAll(async () => {
    ctx = await createE2EContext();
    await ctx.db
      .insert(appSettings)
      .values({ key: 'audiobookshelf_enabled', value: 'true' })
      .onConflictDoUpdate({ target: appSettings.key, set: { value: 'true' } });
    fixture = await createFixtureTree([
      file('A Collection/Book One/track-1.mp3'),
      file('A Collection/Book One/track-2.mp3'),
      file('Author/Book Two/book-two.mp3'),
      file('Ebook Only/ebook.epub'),
    ]);
    hiddenFixture = await createFixtureTree([file('only.epub')], 'abs-hidden-');

    const abs = await seedLibrary(ctx.db, { rootPath: fixture.rootPath, mode: 'book_per_folder', name: 'Audiobooks' });
    await ctx.db.update(libraries).set({ enableAudiobookshelfApi: true }).where(eq(libraries.id, abs.libraryId));
    absLibraryId = abs.libraryId;

    const hidden = await seedLibrary(ctx.db, {
      rootPath: hiddenFixture.rootPath,
      mode: 'book_per_folder',
      name: 'Hidden Library',
    });
    hiddenLibraryId = hidden.libraryId;

    await triggerAndWaitForLibraryScan(ctx, abs.libraryId);

    const audioBooks = await ctx.db.query.books.findMany({
      where: (books, { eq: eqOp }) => eqOp(books.libraryId, absLibraryId),
    });
    const byFolder = new Map(audioBooks.map((book) => [book.folderPath, book]));
    const bookOne = byFolder.get(`${fixture.rootPath}/A Collection/Book One`);
    const bookTwo = byFolder.get(`${fixture.rootPath}/Author/Book Two`);
    if (!bookOne || !bookTwo) throw new Error('Scanner did not create the expected audio books');

    bookOneId = bookOne.id;
    bookTwoId = bookTwo.id;

    // The e2e harness mocks MetadataService, so the scanner writes folder-derived metadata with
    // empty titles. Set explicit titles so title search and metadata mapping are exercised.
    await ctx.db
      .insert(bookMetadata)
      .values([
        { bookId: bookOne.id, title: 'Book One' },
        { bookId: bookTwo.id, title: 'Book Two' },
      ])
      .onConflictDoUpdate({ target: bookMetadata.bookId, set: { title: sql`excluded.title` } });

    const files = await ctx.db.query.bookFiles.findMany({
      where: (bookFiles, { eq: eqOp, and: andOp, inArray }) => andOp(inArray(bookFiles.bookId, [bookOne.id]), eqOp(bookFiles.role, 'content')),
    });
    const ordered = [...files].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
    fileOneId = ordered[0].id;
    fileTwoId = ordered[1].id;
  });

  afterAll(async () => {
    await fixture.cleanup();
    await hiddenFixture.cleanup();
    await closeE2EContext(ctx);
  });

  function absLogin(username: string, password: string) {
    return ctx.app.inject({ method: 'POST', url: '/abs/login', payload: { username, password } });
  }

  function authorized(headers: Record<string, string> = {}) {
    return { authorization: `Bearer ${absToken}`, ...headers };
  }

  let absToken: string;

  describe('authentication', () => {
    it('logs in via POST /login and returns an ABS-shaped user with a token', async () => {
      const response = await absLogin(ADMIN_SETUP_DTO.username, ADMIN_SETUP_DTO.password);
      expect(response.statusCode).toBe(200);

      const body = response.json();
      expect(body.user.username).toBe(ADMIN_SETUP_DTO.username);
      expect(body.user.type).toBe('root');
      expect(body.user.token).toBeTruthy();
      expect(typeof body.user.token).toBe('string');
      expect(Array.isArray(body.user.mediaProgress)).toBe(true);
      expect(body.user.permissions.download).toBe(true);
      expect(body.userDefaultLibraryId).toBe(toAudiobookshelfUuid(absLibraryId));
      expect(body.serverSettings).toBeDefined();

      absToken = body.user.token;
    });

    it('rejects bad credentials', async () => {
      const response = await absLogin(ADMIN_SETUP_DTO.username, 'wrong-password');
      expect(response.statusCode).toBe(401);
    });

    it('rejects a login payload with unknown fields', async () => {
      const response = await ctx.app.inject({ method: 'POST', url: '/abs/login', payload: { username: 'x', password: 'y', extra: true } });
      expect(response.statusCode).toBe(400);
    });
  });

  describe('session endpoints', () => {
    it('validates the token via GET /api/authorize', async () => {
      const response = await ctx.app.inject({ method: 'GET', url: '/abs/api/authorize', headers: authorized() });
      expect(response.statusCode).toBe(200);
      expect(response.json().user.username).toBe(ADMIN_SETUP_DTO.username);
    });

    it('returns the user via GET /api/me', async () => {
      const response = await ctx.app.inject({ method: 'GET', url: '/abs/api/me', headers: authorized() });
      expect(response.statusCode).toBe(200);
      expect(response.json().username).toBe(ADMIN_SETUP_DTO.username);
    });

    it('rejects requests without a token', async () => {
      const response = await ctx.app.inject({ method: 'GET', url: '/abs/api/me' });
      expect(response.statusCode).toBe(401);
    });
  });

  describe('libraries and items', () => {
    it('lists only opted-in libraries', async () => {
      const response = await ctx.app.inject({ method: 'GET', url: '/abs/api/libraries', headers: authorized() });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.libraries).toHaveLength(1);
      expect(body.libraries[0]).toMatchObject({ id: toAudiobookshelfUuid(absLibraryId), name: 'Audiobooks', mediaType: 'book' });
      expect(body.libraries[0].folders).toHaveLength(1);
    });

    it('paginates items and excludes non-audio books', async () => {
      const response = await ctx.app.inject({ method: 'GET', url: `/abs/api/libraries/${absLibraryId}/items?limit=1&page=0`, headers: authorized() });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.total).toBe(2);
      expect(body.limit).toBe(1);
      expect(body.page).toBe(0);
      expect(body.results).toHaveLength(1);
      for (const item of body.results) {
        expect(item.mediaType).toBe('book');
        expect(item.media.numAudioFiles).toBeGreaterThan(0);
        expect(item.media.audioFiles).toBeUndefined();
      }
    });

    it('searches items by title query', async () => {
      const response = await ctx.app.inject({ method: 'GET', url: `/abs/api/libraries/${absLibraryId}/items?search=Book`, headers: authorized() });
      expect(response.statusCode).toBe(200);
      expect(response.json().total).toBe(2);
    });

    it('returns 404 for unknown or non-opted-in libraries', async () => {
      const unknown = await ctx.app.inject({ method: 'GET', url: '/abs/api/libraries/999999/items', headers: authorized() });
      expect(unknown.statusCode).toBe(404);
      const hidden = await ctx.app.inject({ method: 'GET', url: `/abs/api/libraries/${hiddenLibraryId}/items`, headers: authorized() });
      expect(hidden.statusCode).toBe(404);
    });

    it('returns a full LibraryItem with tracks and content urls', async () => {
      const response = await ctx.app.inject({ method: 'GET', url: `/abs/api/items/${bookOneId}`, headers: authorized() });
      expect(response.statusCode).toBe(200);
      const item = response.json();
      expect(item.id).toBe(toAudiobookshelfUuid(bookOneId));
      expect(item.isFile).toBe(false);
      expect(item.media.tracks).toHaveLength(2);
      expect(item.media.tracks[0].contentUrl).toBe(`/abs/api/items/${toAudiobookshelfUuid(bookOneId)}/file/${toAudiobookshelfUuid(fileOneId)}`);
      expect(item.media.tracks[1].contentUrl).toBe(`/abs/api/items/${toAudiobookshelfUuid(bookOneId)}/file/${toAudiobookshelfUuid(fileTwoId)}`);
      // Durations are null under the mocked metadata service, so offsets stay at 0; the
      // mapper unit test covers cumulative offsets with real durations.
      expect(typeof item.media.tracks[1].startOffset).toBe('number');
      expect(item.media.audioFiles[0].mimeType).toBe('audio/mpeg');
    });

    it('hides items that have no audio files', async () => {
      const ebook = await ctx.db.query.books.findFirst({ where: (books, { like }) => like(books.folderPath, '%ebook%') });
      if (ebook) {
        const response = await ctx.app.inject({ method: 'GET', url: `/abs/api/items/${ebook.id}`, headers: authorized() });
        expect(response.statusCode).toBe(404);
      }
    });
  });

  describe('streaming and download', () => {
    it('serves a file without a Range header', async () => {
      const response = await ctx.app.inject({ method: 'GET', url: `/abs/api/items/${bookOneId}/file/${fileOneId}`, headers: authorized() });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('audio/mpeg');
      expect(response.headers['accept-ranges']).toBe('bytes');
    });

    it('honors Range requests with 206 and Content-Range', async () => {
      const response = await ctx.app.inject({
        method: 'GET',
        url: `/abs/api/items/${bookOneId}/file/${fileOneId}`,
        headers: { ...authorized(), range: 'bytes=0-9' },
      });
      expect(response.statusCode).toBe(206);
      expect(response.headers['content-range']).toMatch(/^bytes 0-9\//);
      expect(Number(response.headers['content-length'])).toBe(10);
      expect(response.rawPayload.length).toBe(10);
    });

    it('rejects unsatisfiable ranges with 416', async () => {
      const response = await ctx.app.inject({
        method: 'GET',
        url: `/abs/api/items/${bookOneId}/file/${fileOneId}`,
        headers: { ...authorized(), range: 'bytes=999999999-' },
      });
      expect(response.statusCode).toBe(416);
    });

    it('zips multi-file books on /download', async () => {
      const response = await ctx.app.inject({ method: 'GET', url: `/abs/api/items/${bookOneId}/download`, headers: authorized() });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('application/zip');
      // PK zip magic
      expect(response.rawPayload.subarray(0, 2).toString()).toBe('PK');
    });

    it('streams single-file books directly on /download', async () => {
      const response = await ctx.app.inject({ method: 'GET', url: `/abs/api/items/${bookTwoId}/download`, headers: authorized() });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('audio/mpeg');
    });

    it('downloads a single file via /file/:fileId/download by id or ino', async () => {
      const byId = await ctx.app.inject({ method: 'GET', url: `/abs/api/items/${bookOneId}/file/${fileOneId}/download`, headers: authorized() });
      expect(byId.statusCode).toBe(200);
      expect(byId.headers['content-type']).toContain('audio/mpeg');
      expect(byId.headers['content-disposition']).toContain('attachment');

      const file = await ctx.db.query.bookFiles.findFirst({ where: (bookFiles, { eq }) => eq(bookFiles.id, fileOneId) });
      expect(file).toBeDefined();
      // Prologue builds download urls from the file's ino, matching upstream getLibraryFileWithIno.
      const byIno = await ctx.app.inject({ method: 'GET', url: `/abs/api/items/${bookOneId}/file/${file!.ino}/download`, headers: authorized() });
      expect(byIno.statusCode).toBe(200);
      expect(byIno.rawPayload).toEqual(byId.rawPayload);
    });

    it('serves covers without authentication (upstream public route)', async () => {
      // The fixture books have no cover files, so the assertion is that the route is reachable
      // without a token (404 for missing cover, not 401 for missing auth).
      const response = await ctx.app.inject({ method: 'GET', url: `/abs/api/items/${bookOneId}/cover` });
      expect(response.statusCode).toBe(404);
    });
  });

  describe('progress', () => {
    it('writes progress via PATCH and reads it back via GET /api/me', async () => {
      const patch = await ctx.app.inject({
        method: 'PATCH',
        url: `/abs/api/me/progress/${bookOneId}`,
        headers: { ...authorized(), 'content-type': 'application/json' },
        payload: { currentTime: 15, duration: 400, progress: 0.0375, isFinished: false },
      });
      expect(patch.statusCode).toBe(200);
      expect(patch.json().libraryItemId).toBe(toAudiobookshelfUuid(bookOneId));

      const me = await ctx.app.inject({ method: 'GET', url: '/abs/api/me', headers: authorized() });
      const progress = me.json().mediaProgress.find((p: { libraryItemId: string }) => p.libraryItemId === toAudiobookshelfUuid(bookOneId));
      expect(progress).toBeDefined();
      expect(progress.currentTime).toBe(15);
      expect(progress.isFinished).toBe(false);

      const single = await ctx.app.inject({ method: 'GET', url: `/abs/api/me/progress/${bookOneId}`, headers: authorized() });
      expect(single.statusCode).toBe(200);
      expect(single.json().currentTime).toBe(15);
    });

    it('returns null for progress of an item with no recorded progress', async () => {
      const response = await ctx.app.inject({ method: 'GET', url: `/abs/api/me/progress/${bookTwoId}`, headers: authorized() });
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe('null');
    });
  });

  describe('listening sessions and stats', () => {
    function absListenRows(bookId: number) {
      return ctx.db.query.readingSessions.findMany({
        where: (rs, { and: andOp, eq: eqOp }) => andOp(eqOp(rs.bookId, bookId), eqOp(rs.source, 'abs')),
      });
    }

    it('records play/sync/close as one growing BookOrbit listen session and reads it back', async () => {
      const play = await ctx.app.inject({
        method: 'POST',
        url: `/abs/api/items/${bookOneId}/play`,
        headers: { ...authorized(), 'content-type': 'application/json' },
        payload: { deviceInfo: { deviceId: 'e2e-device', clientName: 'E2E', clientVersion: '1.0' }, mediaPlayer: 'E2EPlayer' },
      });
      expect(play.statusCode).toBe(200);
      const sessionId = play.json().id as string;

      const sync = await ctx.app.inject({
        method: 'POST',
        url: `/abs/api/session/${sessionId}/sync`,
        headers: { ...authorized(), 'content-type': 'application/json' },
        payload: { currentTime: 30, duration: 400, timeListened: 20 },
      });
      expect(sync.statusCode).toBe(200);

      const close = await ctx.app.inject({
        method: 'POST',
        url: `/abs/api/session/${sessionId}/close`,
        headers: { ...authorized(), 'content-type': 'application/json' },
        payload: { currentTime: 50, duration: 400, timeListened: 30 },
      });
      expect(close.statusCode).toBe(200);

      const rows = await absListenRows(bookOneId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ sessionType: 'listen', sourceDeviceKey: 'abs:e2e-device' });
      expect([fileOneId, fileTwoId]).toContain(rows[0]!.bookFileId);
      expect(rows[0]!.sessionId).toMatch(/^abs-live:/);
      // The first report backdates the session by the 20s it covers; the close arrives
      // milliseconds later in this test, so its 30s are capped at the elapsed wall clock.
      expect(rows[0]!.durationSeconds).toBeGreaterThanOrEqual(20);
      expect(rows[0]!.durationSeconds).toBeLessThan(50);

      const list = await ctx.app.inject({ method: 'GET', url: '/abs/api/me/listening-sessions', headers: authorized() });
      expect(list.statusCode).toBe(200);
      const envelope = list.json();
      expect(envelope).toMatchObject({ page: 0, itemsPerPage: 10 });
      expect(envelope.numPages).toBe(Math.ceil(envelope.total / envelope.itemsPerPage));

      const session = envelope.sessions.find((s: { libraryItemId: string }) => s.libraryItemId === toAudiobookshelfUuid(bookOneId));
      expect(session).toMatchObject({
        id: toAudiobookshelfUuid(rows[0]!.id),
        libraryItemId: toAudiobookshelfUuid(bookOneId),
        bookId: toAudiobookshelfUuid(bookOneId),
        libraryId: toAudiobookshelfUuid(absLibraryId),
        displayTitle: 'Book One',
        mediaType: 'book',
        episodeId: null,
        mediaPlayer: 'audiobookshelf',
        deviceInfo: { deviceId: 'e2e-device' },
        timeListening: rows[0]!.durationSeconds,
      });
      expect(typeof session.startedAt).toBe('number');
      expect(typeof session.updatedAt).toBe('number');
    });

    it('shows ABS listening in the BookOrbit reading log under the Audiobookshelf source', async () => {
      const response = await ctx.app.inject({ method: 'GET', url: `/api/v1/books/${bookOneId}/sessions`, headers: authorized() });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.items.some((item: { source: string }) => item.source === 'abs')).toBe(true);
    });

    it('stores offline sessions keyed by the client id so a re-upload grows the session instead of duplicating it', async () => {
      const now = Date.now();
      const local = {
        id: 'e2e-local-session-1',
        libraryItemId: toAudiobookshelfUuid(bookTwoId),
        startTime: 0,
        currentTime: 12,
        duration: 300,
        timeListening: 25,
        deviceInfo: { deviceId: 'e2e-local' },
        startedAt: now - 60_000,
        updatedAt: now - 30_000,
      };
      const upload = (payload: unknown) =>
        ctx.app.inject({
          method: 'POST',
          url: '/abs/api/session/local-all',
          headers: { ...authorized(), 'content-type': 'application/json' },
          payload,
        });

      expect((await upload([local])).statusCode).toBe(200);
      expect((await upload([local])).statusCode).toBe(200);
      expect((await upload([{ ...local, currentTime: 40, timeListening: 50, updatedAt: now - 5_000 }])).statusCode).toBe(200);

      const rows = await absListenRows(bookTwoId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ sessionId: 'abs-local:e2e-local-session-1', durationSeconds: 50, sourceDeviceKey: 'abs:e2e-local' });

      const list = await ctx.app.inject({ method: 'GET', url: `/abs/api/me/item/listening-sessions/${bookTwoId}`, headers: authorized() });
      expect(list.json().sessions).toEqual([
        expect.objectContaining({ libraryItemId: toAudiobookshelfUuid(bookTwoId), displayTitle: 'Book Two', timeListening: 50 }),
      ]);
    });

    it('filters listening sessions by library item and 404s unknown items', async () => {
      const response = await ctx.app.inject({ method: 'GET', url: `/abs/api/me/item/listening-sessions/${bookOneId}`, headers: authorized() });
      expect(response.statusCode).toBe(200);
      const envelope = response.json();
      expect(envelope.sessions.length).toBeGreaterThan(0);
      for (const session of envelope.sessions) {
        expect(session.libraryItemId).toBe(toAudiobookshelfUuid(bookOneId));
      }

      const unknown = await ctx.app.inject({ method: 'GET', url: '/abs/api/me/item/listening-sessions/999999', headers: authorized() });
      expect(unknown.statusCode).toBe(404);
    });

    it('aggregates listening stats in the upstream shape from the reading history', async () => {
      const response = await ctx.app.inject({ method: 'GET', url: '/abs/api/me/listening-stats', headers: authorized() });
      expect(response.statusCode).toBe(200);
      const stats = response.json();
      const [liveRow] = await absListenRows(bookOneId);

      const item = stats.items[toAudiobookshelfUuid(bookOneId)];
      expect(item).toMatchObject({
        id: toAudiobookshelfUuid(bookOneId),
        timeListening: liveRow!.durationSeconds,
        mediaMetadata: { title: 'Book One' },
      });
      expect(typeof item.lastUpdate).toBe('number');
      expect(stats.items[toAudiobookshelfUuid(bookTwoId)]).toMatchObject({ timeListening: 50 });

      expect(stats.totalTime).toBe(liveRow!.durationSeconds + 50);
      expect(stats.today).toBeGreaterThanOrEqual(liveRow!.durationSeconds);
      const todayKey = new Date().toISOString().slice(0, 10);
      expect(stats.days[todayKey]).toBeGreaterThan(0);
      expect(Object.values(stats.dayOfWeek).reduce((sum: number, value) => sum + (value as number), 0)).toBe(stats.totalTime);
      expect(stats.recentSessions.length).toBe(2);
    });
  });

  describe('authors, series, and collections', () => {
    it('lists authors of a library with derived timestamps', async () => {
      const [author] = await ctx.db.insert(authors).values({ name: 'Ada Lovelace' }).returning({ id: authors.id });
      await ctx.db.insert(bookAuthors).values({ bookId: bookOneId, authorId: author.id, displayOrder: 0 });

      const response = await ctx.app.inject({ method: 'GET', url: `/abs/api/libraries/${absLibraryId}/authors`, headers: authorized() });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(Array.isArray(body.authors)).toBe(true);
      const mapped = body.authors.find((a: { id: string }) => a.id === toAudiobookshelfUuid(author.id));
      expect(mapped).toBeDefined();
      // addedAt/updatedAt are SQL-derived from the author's books and must be epoch numbers, not strings.
      expect(typeof mapped.addedAt).toBe('number');
      expect(typeof mapped.updatedAt).toBe('number');
      expect(mapped.addedAt).toBeGreaterThan(0);
    });

    it('lists series of a library', async () => {
      const response = await ctx.app.inject({ method: 'GET', url: `/abs/api/libraries/${absLibraryId}/series`, headers: authorized() });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(Array.isArray(body.results)).toBe(true);
      expect(typeof body.total).toBe('number');
    });

    it('exposes the user collections with only exposed audio items', async () => {
      const [collection] = await ctx.db.insert(collections).values({ userId: 1, name: 'Test Shelf' }).returning({ id: collections.id });
      await ctx.db.insert(collectionBooks).values({ collectionId: collection.id, bookId: bookOneId });

      const list = await ctx.app.inject({ method: 'GET', url: '/abs/api/collections', headers: authorized() });
      expect(list.statusCode).toBe(200);
      expect(list.json().collections).toHaveLength(1);
      expect(list.json().collections[0]).toMatchObject({ id: toAudiobookshelfUuid(collection.id), name: 'Test Shelf' });
      expect(list.json().collections[0].books).toHaveLength(1);
      expect(list.json().collections[0].books[0].id).toBe(toAudiobookshelfUuid(bookOneId));

      const single = await ctx.app.inject({ method: 'GET', url: `/abs/api/collections/${collection.id}`, headers: authorized() });
      expect(single.statusCode).toBe(200);
      expect(single.json().books[0].id).toBe(toAudiobookshelfUuid(bookOneId));
    });
  });

  describe('user isolation', () => {
    it('does not expose libraries or items to users without library access', async () => {
      const passwordHash = await hash('Outsider123', 4);
      await ctx.db.insert(users).values({
        username: 'abs-outsider',
        name: 'ABS Outsider',
        email: 'abs-outsider@example.com',
        passwordHash,
        isSuperuser: false,
        isDefaultPassword: false,
        provisioningMethod: 'local',
      });

      const login = await absLogin('abs-outsider', 'Outsider123');
      expect(login.statusCode).toBe(200);
      const outsiderToken = login.json().user.token;

      const libraries = await ctx.app.inject({ method: 'GET', url: '/abs/api/libraries', headers: { authorization: `Bearer ${outsiderToken}` } });
      expect(libraries.json().libraries).toEqual([]);

      const item = await ctx.app.inject({ method: 'GET', url: `/abs/api/items/${bookOneId}`, headers: { authorization: `Bearer ${outsiderToken}` } });
      expect(item.statusCode).toBe(404);
    });

    it('gates download routes on the library_download permission', async () => {
      const passwordHash = await hash('Downloader123', 4);
      const [downloader] = await ctx.db
        .insert(users)
        .values({
          username: 'abs-downloader',
          name: 'ABS Downloader',
          email: 'abs-downloader@example.com',
          passwordHash,
          isSuperuser: false,
          isDefaultPassword: false,
          provisioningMethod: 'local',
        })
        .returning({ id: users.id });
      await ctx.db.insert(userLibraryAccess).values({ userId: downloader.id, libraryId: absLibraryId, accessLevel: 'viewer' });

      const login = await absLogin('abs-downloader', 'Downloader123');
      expect(login.statusCode).toBe(200);
      expect(login.json().user.permissions.download).toBe(false);
      const token = login.json().user.token;

      const denied = await ctx.app.inject({
        method: 'GET',
        url: `/abs/api/items/${bookTwoId}/download`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(denied.statusCode).toBe(403);
      const deniedFile = await ctx.app.inject({
        method: 'GET',
        url: `/abs/api/items/${bookTwoId}/file/${fileTwoId}/download`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(deniedFile.statusCode).toBe(403);

      await ctx.db.insert(userPermissions).values({ userId: downloader.id, permissionName: 'library_download' });
      const relogin = await absLogin('abs-downloader', 'Downloader123');
      expect(relogin.json().user.permissions.download).toBe(true);
      const allowed = await ctx.app.inject({
        method: 'GET',
        url: `/abs/api/items/${bookTwoId}/download`,
        headers: { authorization: `Bearer ${relogin.json().user.token}` },
      });
      expect(allowed.statusCode).toBe(200);
    });
  });

  describe('public session streaming', () => {
    it('streams tracks of an open session without auth and 404s unknown sessions', async () => {
      const play = await ctx.app.inject({
        method: 'POST',
        url: `/abs/api/items/${bookOneId}/play`,
        headers: { ...authorized(), 'content-type': 'application/json' },
        payload: { deviceInfo: { deviceId: 'public-session-test', clientName: 'e2e', clientVersion: '1.0' }, mediaPlayer: 'e2e' },
      });
      expect(play.statusCode).toBe(200);
      const sessionId = play.json().id as string;

      const track = await ctx.app.inject({ method: 'GET', url: `/abs/public/session/${sessionId}/track/0` });
      expect(track.statusCode).toBe(200);
      expect(track.headers['content-type']).toContain('audio/mpeg');
      expect(track.headers['accept-ranges']).toBe('bytes');

      const ranged = await ctx.app.inject({ method: 'GET', url: `/abs/public/session/${sessionId}/track/0`, headers: { range: 'bytes=0-9' } });
      expect(ranged.statusCode).toBe(206);
      expect(ranged.headers['content-range']).toMatch(/^bytes 0-9\//);

      const unknown = await ctx.app.inject({ method: 'GET', url: '/abs/public/session/00000000-0000-4000-8000-0000ffffffffff/track/0' });
      expect(unknown.statusCode).toBe(404);

      const badIndex = await ctx.app.inject({ method: 'GET', url: `/abs/public/session/${sessionId}/track/99` });
      expect(badIndex.statusCode).toBe(404);
    });

    it('404s the public track route once the session is closed', async () => {
      const play = await ctx.app.inject({
        method: 'POST',
        url: `/abs/api/items/${bookTwoId}/play`,
        headers: { ...authorized(), 'content-type': 'application/json' },
        payload: { deviceInfo: { deviceId: 'public-session-close', clientName: 'e2e', clientVersion: '1.0' }, mediaPlayer: 'e2e' },
      });
      expect(play.statusCode).toBe(200);
      const sessionId = play.json().id as string;

      const close = await ctx.app.inject({
        method: 'POST',
        url: `/abs/api/session/${sessionId}/close`,
        headers: { ...authorized(), 'content-type': 'application/json' },
        payload: {},
      });
      expect(close.statusCode).toBe(200);

      const afterClose = await ctx.app.inject({ method: 'GET', url: `/abs/public/session/${sessionId}/track/0` });
      expect(afterClose.statusCode).toBe(404);
    });
  });
});
