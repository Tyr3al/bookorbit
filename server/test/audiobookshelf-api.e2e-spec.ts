import { hash } from 'bcryptjs';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createFixtureTree, file, type FixtureTree } from './e2e/scanner/scanner-fixture-builder';
import { ADMIN_SETUP_DTO, closeE2EContext, createE2EContext, seedLibrary, triggerAndWaitForLibraryScan, type E2EContext } from './e2e/app-harness';
import { bookMetadata, libraries, users, collections, collectionBooks } from '../src/db/schema';

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
    return ctx.app.inject({ method: 'POST', url: '/login', payload: { username, password } });
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
      expect(body.userDefaultLibraryId).toBe(String(absLibraryId));
      expect(body.serverSettings).toBeDefined();

      absToken = body.user.token;
    });

    it('rejects bad credentials', async () => {
      const response = await absLogin(ADMIN_SETUP_DTO.username, 'wrong-password');
      expect(response.statusCode).toBe(401);
    });

    it('rejects a login payload with unknown fields', async () => {
      const response = await ctx.app.inject({ method: 'POST', url: '/login', payload: { username: 'x', password: 'y', extra: true } });
      expect(response.statusCode).toBe(400);
    });
  });

  describe('session endpoints', () => {
    it('validates the token via GET /api/authorize', async () => {
      const response = await ctx.app.inject({ method: 'GET', url: '/api/authorize', headers: authorized() });
      expect(response.statusCode).toBe(200);
      expect(response.json().user.username).toBe(ADMIN_SETUP_DTO.username);
    });

    it('returns the user via GET /api/me', async () => {
      const response = await ctx.app.inject({ method: 'GET', url: '/api/me', headers: authorized() });
      expect(response.statusCode).toBe(200);
      expect(response.json().username).toBe(ADMIN_SETUP_DTO.username);
    });

    it('rejects requests without a token', async () => {
      const response = await ctx.app.inject({ method: 'GET', url: '/api/me' });
      expect(response.statusCode).toBe(401);
    });
  });

  describe('libraries and items', () => {
    it('lists only opted-in libraries', async () => {
      const response = await ctx.app.inject({ method: 'GET', url: '/api/libraries', headers: authorized() });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.libraries).toHaveLength(1);
      expect(body.libraries[0]).toMatchObject({ id: String(absLibraryId), name: 'Audiobooks', mediaType: 'book' });
      expect(body.libraries[0].folders).toHaveLength(1);
    });

    it('paginates items and excludes non-audio books', async () => {
      const response = await ctx.app.inject({ method: 'GET', url: `/api/libraries/${absLibraryId}/items?limit=1&page=0`, headers: authorized() });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.total).toBe(2);
      expect(body.limit).toBe(1);
      expect(body.page).toBe(0);
      expect(body.results).toHaveLength(1);
      for (const item of body.results) {
        expect(item.mediaType).toBe('book');
        expect(item.media.audioFiles.length).toBeGreaterThan(0);
        expect(item.media.audioFiles[0].metadata.filename.endsWith('.mp3')).toBe(true);
      }
    });

    it('searches items by title query', async () => {
      const response = await ctx.app.inject({ method: 'GET', url: `/api/libraries/${absLibraryId}/items?search=Book`, headers: authorized() });
      expect(response.statusCode).toBe(200);
      expect(response.json().total).toBe(2);
    });

    it('returns 404 for unknown or non-opted-in libraries', async () => {
      const unknown = await ctx.app.inject({ method: 'GET', url: '/api/libraries/999999/items', headers: authorized() });
      expect(unknown.statusCode).toBe(404);
      const hidden = await ctx.app.inject({ method: 'GET', url: `/api/libraries/${hiddenLibraryId}/items`, headers: authorized() });
      expect(hidden.statusCode).toBe(404);
    });

    it('returns a full LibraryItem with tracks and content urls', async () => {
      const response = await ctx.app.inject({ method: 'GET', url: `/api/items/${bookOneId}`, headers: authorized() });
      expect(response.statusCode).toBe(200);
      const item = response.json();
      expect(item.id).toBe(String(bookOneId));
      expect(item.isFile).toBe(false);
      expect(item.media.tracks).toHaveLength(2);
      expect(item.media.tracks[0].contentUrl).toBe(`/api/items/${bookOneId}/file/${fileOneId}`);
      expect(item.media.tracks[1].contentUrl).toBe(`/api/items/${bookOneId}/file/${fileTwoId}`);
      // Durations are null under the mocked metadata service, so offsets stay at 0; the
      // mapper unit test covers cumulative offsets with real durations.
      expect(typeof item.media.tracks[1].startOffset).toBe('number');
      expect(item.media.audioFiles[0].mimeType).toBe('audio/mpeg');
    });

    it('hides items that have no audio files', async () => {
      const ebook = await ctx.db.query.books.findFirst({ where: (books, { like }) => like(books.folderPath, '%ebook%') });
      if (ebook) {
        const response = await ctx.app.inject({ method: 'GET', url: `/api/items/${ebook.id}`, headers: authorized() });
        expect(response.statusCode).toBe(404);
      }
    });
  });

  describe('streaming and download', () => {
    it('serves a file without a Range header', async () => {
      const response = await ctx.app.inject({ method: 'GET', url: `/api/items/${bookOneId}/file/${fileOneId}`, headers: authorized() });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('audio/mpeg');
      expect(response.headers['accept-ranges']).toBe('bytes');
    });

    it('honors Range requests with 206 and Content-Range', async () => {
      const response = await ctx.app.inject({
        method: 'GET',
        url: `/api/items/${bookOneId}/file/${fileOneId}`,
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
        url: `/api/items/${bookOneId}/file/${fileOneId}`,
        headers: { ...authorized(), range: 'bytes=999999999-' },
      });
      expect(response.statusCode).toBe(416);
    });

    it('zips multi-file books on /download', async () => {
      const response = await ctx.app.inject({ method: 'GET', url: `/api/items/${bookOneId}/download`, headers: authorized() });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('application/zip');
      // PK zip magic
      expect(response.rawPayload.subarray(0, 2).toString()).toBe('PK');
    });

    it('streams single-file books directly on /download', async () => {
      const response = await ctx.app.inject({ method: 'GET', url: `/api/items/${bookTwoId}/download`, headers: authorized() });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('audio/mpeg');
    });

    it('returns 404 for covers when none exists', async () => {
      const response = await ctx.app.inject({ method: 'GET', url: `/api/items/${bookOneId}/cover`, headers: authorized() });
      expect(response.statusCode).toBe(404);
    });
  });

  describe('progress', () => {
    it('writes progress via PATCH and reads it back via GET /api/me', async () => {
      const patch = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/me/progress/${bookOneId}`,
        headers: { ...authorized(), 'content-type': 'application/json' },
        payload: { currentTime: 15, duration: 400, progress: 0.0375, isFinished: false },
      });
      expect(patch.statusCode).toBe(200);
      expect(patch.json().libraryItemId).toBe(String(bookOneId));

      const me = await ctx.app.inject({ method: 'GET', url: '/api/me', headers: authorized() });
      const progress = me.json().mediaProgress.find((p: { libraryItemId: string }) => p.libraryItemId === String(bookOneId));
      expect(progress).toBeDefined();
      expect(progress.currentTime).toBe(15);
      expect(progress.isFinished).toBe(false);

      const single = await ctx.app.inject({ method: 'GET', url: `/api/me/progress/${bookOneId}`, headers: authorized() });
      expect(single.statusCode).toBe(200);
      expect(single.json().currentTime).toBe(15);
    });

    it('returns null for progress of an item with no recorded progress', async () => {
      const response = await ctx.app.inject({ method: 'GET', url: `/api/me/progress/${bookTwoId}`, headers: authorized() });
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe('null');
    });
  });

  describe('authors, series, and collections', () => {
    it('lists authors of a library', async () => {
      const response = await ctx.app.inject({ method: 'GET', url: `/api/libraries/${absLibraryId}/authors`, headers: authorized() });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toHaveProperty('authors');
    });

    it('lists series of a library', async () => {
      const response = await ctx.app.inject({ method: 'GET', url: `/api/libraries/${absLibraryId}/series`, headers: authorized() });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toHaveProperty('series');
    });

    it('exposes the user collections with only exposed audio items', async () => {
      const [collection] = await ctx.db.insert(collections).values({ userId: 1, name: 'Test Shelf' }).returning({ id: collections.id });
      await ctx.db.insert(collectionBooks).values({ collectionId: collection.id, bookId: bookOneId });

      const list = await ctx.app.inject({ method: 'GET', url: '/api/collections', headers: authorized() });
      expect(list.statusCode).toBe(200);
      expect(list.json().collections).toHaveLength(1);
      expect(list.json().collections[0]).toMatchObject({ id: String(collection.id), name: 'Test Shelf' });
      expect(list.json().collections[0].books).toHaveLength(1);
      expect(list.json().collections[0].books[0].id).toBe(String(bookOneId));

      const single = await ctx.app.inject({ method: 'GET', url: `/api/collections/${collection.id}`, headers: authorized() });
      expect(single.statusCode).toBe(200);
      expect(single.json().books[0].id).toBe(String(bookOneId));
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

      const libraries = await ctx.app.inject({ method: 'GET', url: '/api/libraries', headers: { authorization: `Bearer ${outsiderToken}` } });
      expect(libraries.json()).toEqual([]);

      const item = await ctx.app.inject({ method: 'GET', url: `/api/items/${bookOneId}`, headers: { authorization: `Bearer ${outsiderToken}` } });
      expect(item.statusCode).toBe(404);
    });
  });
});
