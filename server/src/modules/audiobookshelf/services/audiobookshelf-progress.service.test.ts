import { describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';

import { AudiobookshelfProgressService } from './audiobookshelf-progress.service';
import type { AudiobookshelfRepository } from '../audiobookshelf.repository';
import type { AudiobookshelfItemsService } from './audiobookshelf-items.service';
import type { BookService } from '../book/book.service';
import type { BookFile } from '../../db/schema';
import type { RequestUser } from '../../common/types/request-user';
import { toAudiobookshelfCompositeUuid, toAudiobookshelfUuid } from '../../../common/utils/audiobookshelf-id.utils';

function audioFile(overrides: Partial<BookFile> = {}): BookFile {
  return {
    id: 11,
    bookId: 7,
    libraryFolderId: 5,
    absolutePath: '/books/Book/track-1.mp3',
    relPath: 'track-1.mp3',
    ino: 1n,
    sizeBytes: 1000,
    mtime: new Date('2024-01-01T00:00:00Z'),
    fileHash: null,
    format: 'mp3',
    role: 'content',
    sortOrder: 0,
    durationSeconds: 60,
    isFixedLayout: null,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    capturedAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}

function user(): RequestUser {
  return {
    id: 1,
    username: 'u',
    name: 'U',
    email: null,
    active: true,
    isSuperuser: false,
    isDefaultPassword: false,
    tokenVersion: 1,
    settings: {},
    avatarUrl: null,
    provisioningMethod: 'local',
    permissions: [],
    contentFilters: { includeTagIds: [], includeGenreIds: [], excludeTagIds: [], excludeGenreIds: [] },
  };
}

function makeService(overrides: { files?: BookFile[] } = {}) {
  const files = overrides.files ?? [audioFile(), audioFile({ id: 12, absolutePath: '/books/Book/track-2.mp3', sortOrder: 1, durationSeconds: 60 })];
  const repository = {
    findProgressForAudiobookshelfUser: vi.fn().mockResolvedValue([]),
    findItemsInProgressForAudiobookshelfUser: vi.fn().mockResolvedValue([{ bookId: 7, progressLastUpdate: new Date('2024-01-02T00:00:00Z') }]),
    findProgressByUserIdAndBookIds: vi.fn().mockResolvedValue([
      {
        userId: 1,
        bookId: 7,
        percentage: 25,
        currentFileId: 11,
        positionSeconds: 10,
        updatedAt: new Date('2024-01-01T00:00:00Z'),
        capturedAt: new Date('2024-01-01T00:00:00Z'),
      },
    ]),
    findAudioFilesByBookId: vi.fn().mockResolvedValue(files),
    findAudioFilesByBookIds: vi.fn().mockResolvedValue(files),
    findExposedAudioBooksByIds: vi.fn().mockImplementation((bookIds: number[]) => Promise.resolve(bookIds.map((id) => ({ id, libraryId: 3 })))),
    deleteProgressByUserIdAndBookId: vi.fn().mockResolvedValue(true),
  } as unknown as AudiobookshelfRepository;
  const itemsService = {
    requireExposedBook: vi.fn().mockResolvedValue({ id: 7, libraryId: 3 }),
    getMinifiedItemsByIds: vi.fn().mockResolvedValue([{ id: toAudiobookshelfUuid(7) }]),
  } as unknown as AudiobookshelfItemsService;
  const bookService = { saveAudioProgress: vi.fn().mockResolvedValue(undefined) } as unknown as BookService;
  const sessionsService = { recordLocalSessions: vi.fn().mockResolvedValue(undefined) };

  const service = new AudiobookshelfProgressService(repository, bookService, itemsService, sessionsService as never);
  return { service, repository, bookService, itemsService, sessionsService };
}

describe('AudiobookshelfProgressService.getMediaProgressForUser', () => {
  it('queries progress through the ABS visibility scope', async () => {
    const { service, repository } = makeService();
    await service.getMediaProgressForUser(user());

    expect(repository.findProgressForAudiobookshelfUser).toHaveBeenCalledWith(user());
  });
});

describe('AudiobookshelfProgressService.getItemsInProgress', () => {
  it('returns SQL-ordered progress items with their last update timestamp', async () => {
    const { service, repository, itemsService } = makeService();

    await expect(service.getItemsInProgress(user())).resolves.toEqual({
      libraryItems: [{ id: toAudiobookshelfUuid(7), progressLastUpdate: Date.parse('2024-01-02T00:00:00Z') }],
    });
    expect(repository.findItemsInProgressForAudiobookshelfUser).toHaveBeenCalledWith(user(), 25);
    expect(itemsService.getMinifiedItemsByIds).toHaveBeenCalledWith([7]);
  });

  it('bounds the requested limit before querying', async () => {
    const { service, repository } = makeService();

    await service.getItemsInProgress(user(), 1000);

    expect(repository.findItemsInProgressForAudiobookshelfUser).toHaveBeenCalledWith(user(), 100);
  });
});

describe('AudiobookshelfProgressService.toMediaProgress', () => {
  it('computes the absolute position across files and the progress fraction', () => {
    const { service } = makeService();
    const row = {
      userId: 1,
      bookId: 7,
      percentage: 25,
      currentFileId: 12,
      positionSeconds: 10,
      updatedAt: new Date('2024-01-01T00:00:00Z'),
      capturedAt: new Date('2024-01-01T00:00:00Z'),
    };
    const progress = service.toMediaProgress(row, [audioFile(), audioFile({ id: 12, sortOrder: 1, durationSeconds: 60 })]);

    expect(progress.progress).toBe(0.25);
    expect(progress.currentTime).toBe(70);
    expect(progress.duration).toBe(120);
    expect(progress.isFinished).toBe(false);
    expect(progress.libraryItemId).toBe(toAudiobookshelfUuid(7));
    expect(progress.mediaItemType).toBe('book');
  });

  it('marks progress as finished at the ABS threshold', () => {
    const { service } = makeService();
    const progress = service.toMediaProgress(
      {
        userId: 1,
        bookId: 7,
        percentage: 99,
        currentFileId: 12,
        positionSeconds: 0,
        updatedAt: new Date('2024-01-01T00:00:00Z'),
        capturedAt: new Date('2024-01-01T00:00:00Z'),
      },
      [audioFile(), audioFile({ id: 12, sortOrder: 1, durationSeconds: 60 })],
    );
    expect(progress.isFinished).toBe(true);
  });
});

describe('AudiobookshelfProgressService.updateMediaProgress', () => {
  it('resolves currentTime into the correct file and file-local seconds', async () => {
    const { service, bookService } = makeService();
    await service.updateMediaProgress(user(), 7, { currentTime: 70, duration: 120, progress: 70 / 120 });

    expect(bookService.saveAudioProgress).toHaveBeenCalledWith(
      1,
      7,
      expect.objectContaining({ currentFileId: 12, positionSeconds: 10, percentage: expect.closeTo(58.33, 1) }),
      expect.anything(),
    );
  });

  it('falls back to progress fraction when currentTime is absent', async () => {
    const { service, bookService } = makeService();
    await service.updateMediaProgress(user(), 7, { duration: 120, progress: 0.5 });

    expect(bookService.saveAudioProgress).toHaveBeenCalledWith(
      1,
      7,
      expect.objectContaining({ currentFileId: 12, positionSeconds: 0, percentage: 50 }),
      expect.anything(),
    );
  });

  it('clamps currentTime to the total duration', async () => {
    const { service, bookService } = makeService();
    await service.updateMediaProgress(user(), 7, { currentTime: 5000, duration: 120 });

    expect(bookService.saveAudioProgress).toHaveBeenCalledWith(
      1,
      7,
      expect.objectContaining({ currentFileId: 12, positionSeconds: 60, percentage: 100 }),
      expect.anything(),
    );
  });

  it('ignores an older ABS update and returns the persisted position', async () => {
    const { service, bookService } = makeService();

    const result = await service.updateMediaProgress(user(), 7, { currentTime: 110, lastUpdate: Date.parse('2023-01-01T00:00:00Z') });

    expect(bookService.saveAudioProgress).not.toHaveBeenCalled();
    expect(result.currentTime).toBe(10);
    expect(result.lastUpdate).toBe(Date.parse('2024-01-01T00:00:00Z'));
  });

  it('persists a newer ABS update with its source timestamp', async () => {
    const { service, bookService } = makeService();
    const timestamp = Date.parse('2025-01-01T00:00:00Z');

    await service.updateMediaProgress(user(), 7, { currentTime: 110, lastUpdate: timestamp });

    expect(bookService.saveAudioProgress).toHaveBeenCalledWith(
      1,
      7,
      expect.objectContaining({ currentFileId: 12, positionSeconds: 50 }),
      expect.anything(),
      new Date(timestamp),
    );
  });

  it('accepts an equal ABS timestamp as an idempotent update', async () => {
    const { service, bookService } = makeService();
    const timestamp = Date.parse('2024-01-01T00:00:00Z');

    await service.updateMediaProgress(user(), 7, { currentTime: 20, lastUpdate: timestamp });

    expect(bookService.saveAudioProgress).toHaveBeenCalledWith(
      1,
      7,
      expect.objectContaining({ positionSeconds: 20 }),
      expect.anything(),
      new Date(timestamp),
    );
  });

  it('passes explicit finish state through to the shared progress writer', async () => {
    const { service, bookService } = makeService();

    await service.updateMediaProgress(user(), 7, { currentTime: 20, isFinished: false });

    expect(bookService.saveAudioProgress).toHaveBeenCalledWith(
      1,
      7,
      expect.objectContaining({ positionSeconds: 20 }),
      expect.anything(),
      undefined,
      false,
    );
  });

  it('preserves explicit finish state for locally synced sessions', async () => {
    const { service, bookService } = makeService();

    await service.syncLocalSessions(user(), [{ libraryItemId: toAudiobookshelfUuid(7), currentTime: 120, isFinished: true }]);

    expect(bookService.saveAudioProgress).toHaveBeenCalledWith(
      1,
      7,
      expect.objectContaining({ percentage: 100 }),
      expect.anything(),
      undefined,
      true,
    );
  });

  it('records one local session using the shared progress update path', async () => {
    const { service, bookService } = makeService();

    await service.syncLocalSession(user(), { libraryItemId: toAudiobookshelfUuid(7), currentTime: 30, isFinished: false, extra: 'ignored' });

    expect(bookService.saveAudioProgress).toHaveBeenCalledWith(
      1,
      7,
      expect.objectContaining({ positionSeconds: 30 }),
      expect.anything(),
      undefined,
      false,
    );
  });

  it('persists a session row for a single local session', async () => {
    const { service, sessionsService } = makeService();

    await service.syncLocalSession(user(), { libraryItemId: toAudiobookshelfUuid(7), currentTime: 30, timeListening: 15, displayTitle: 'A Book' });

    expect(sessionsService.recordLocalSessions).toHaveBeenCalledWith(1, [
      expect.objectContaining({ bookId: 7, libraryId: 3, currentTime: 30, timeListening: 15, displayTitle: 'A Book' }),
    ]);
  });

  it('swallows a session persistence failure without breaking the single local sync', async () => {
    const { service, sessionsService, bookService } = makeService();
    sessionsService.recordLocalSessions.mockRejectedValue(new Error('db unavailable'));

    await expect(service.syncLocalSession(user(), { libraryItemId: toAudiobookshelfUuid(7), currentTime: 30 })).resolves.toBeUndefined();
    expect(bookService.saveAudioProgress).toHaveBeenCalled();
  });

  it('rejects malformed single local sessions', async () => {
    const { service } = makeService();

    await expect(service.syncLocalSession(user(), { currentTime: 30 })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.syncLocalSession(user(), { libraryItemId: toAudiobookshelfUuid(7) })).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('AudiobookshelfProgressService.batchUpdateMediaProgress', () => {
  it('applies accessible entries and silently skips an inaccessible one', async () => {
    const { service, repository, bookService } = makeService();
    vi.mocked(repository.findExposedAudioBooksByIds).mockResolvedValue([{ id: 7 }] as never);
    vi.mocked(repository.findProgressByUserIdAndBookIds).mockResolvedValue([]);

    await service.batchUpdateMediaProgress(user(), [
      { libraryItemId: toAudiobookshelfUuid(7), currentTime: 30 },
      { libraryItemId: toAudiobookshelfUuid(99), currentTime: 10 },
    ]);

    expect(bookService.saveAudioProgress).toHaveBeenCalledTimes(1);
    expect(bookService.saveAudioProgress).toHaveBeenCalledWith(1, 7, expect.objectContaining({ positionSeconds: 30 }), expect.anything());
  });

  it('skips a stale entry using the batch-loaded progress row rather than writing', async () => {
    const { service, repository, bookService } = makeService();
    vi.mocked(repository.findExposedAudioBooksByIds).mockResolvedValue([{ id: 7 }] as never);
    vi.mocked(repository.findProgressByUserIdAndBookIds).mockResolvedValue([
      {
        userId: 1,
        bookId: 7,
        percentage: 25,
        currentFileId: 11,
        positionSeconds: 10,
        updatedAt: new Date('2025-01-01T00:00:00Z'),
        capturedAt: new Date('2025-01-01T00:00:00Z'),
      },
    ] as never);

    await service.batchUpdateMediaProgress(user(), [
      { libraryItemId: toAudiobookshelfUuid(7), currentTime: 30, lastUpdate: Date.parse('2023-01-01T00:00:00Z') },
    ]);

    expect(bookService.saveAudioProgress).not.toHaveBeenCalled();
  });

  it('performs a single access lookup and a single file/progress load for the whole batch', async () => {
    const { service, repository } = makeService();
    vi.mocked(repository.findExposedAudioBooksByIds).mockResolvedValue([{ id: 7 }, { id: 8 }] as never);
    vi.mocked(repository.findProgressByUserIdAndBookIds).mockResolvedValue([]);

    await service.batchUpdateMediaProgress(user(), [
      { libraryItemId: toAudiobookshelfUuid(7), currentTime: 10 },
      { libraryItemId: toAudiobookshelfUuid(8), currentTime: 20 },
      { libraryItemId: toAudiobookshelfUuid(7), currentTime: 15 },
    ]);

    expect(repository.findExposedAudioBooksByIds).toHaveBeenCalledTimes(1);
    expect(repository.findExposedAudioBooksByIds).toHaveBeenCalledWith([7, 8], user());
    expect(repository.findAudioFilesByBookIds).toHaveBeenCalledTimes(1);
    expect(repository.findAudioFilesByBookIds).toHaveBeenCalledWith([7, 8]);
    expect(repository.findProgressByUserIdAndBookIds).toHaveBeenCalledTimes(1);
    expect(repository.findProgressByUserIdAndBookIds).toHaveBeenCalledWith(1, [7, 8]);
  });

  it('applies repeated entries for one book in arrival order', async () => {
    const { service, repository, bookService } = makeService();
    vi.mocked(repository.findExposedAudioBooksByIds).mockResolvedValue([{ id: 7 }, { id: 8 }] as never);
    vi.mocked(repository.findProgressByUserIdAndBookIds).mockResolvedValue([]);

    await service.batchUpdateMediaProgress(user(), [
      { libraryItemId: toAudiobookshelfUuid(7), currentTime: 10 },
      { libraryItemId: toAudiobookshelfUuid(8), currentTime: 20 },
      { libraryItemId: toAudiobookshelfUuid(7), currentTime: 15 },
    ]);

    const positionsForBook7 = vi
      .mocked(bookService.saveAudioProgress)
      .mock.calls.filter((call) => call[1] === 7)
      .map((call) => call[2].positionSeconds);
    expect(positionsForBook7).toEqual([10, 15]);
  });

  it('keeps the newest timestamp when the same book repeats within a batch', async () => {
    const { service, repository, bookService } = makeService();
    vi.mocked(repository.findExposedAudioBooksByIds).mockResolvedValue([{ id: 7 }] as never);
    vi.mocked(repository.findProgressByUserIdAndBookIds).mockResolvedValue([]);

    await service.batchUpdateMediaProgress(user(), [
      { libraryItemId: toAudiobookshelfUuid(7), currentTime: 30, lastUpdate: Date.parse('2025-06-01T00:00:00Z') },
      { libraryItemId: toAudiobookshelfUuid(7), currentTime: 10, lastUpdate: Date.parse('2025-01-01T00:00:00Z') },
    ]);

    expect(bookService.saveAudioProgress).toHaveBeenCalledTimes(1);
    expect(bookService.saveAudioProgress).toHaveBeenCalledWith(
      1,
      7,
      expect.objectContaining({ positionSeconds: 30 }),
      expect.anything(),
      new Date(Date.parse('2025-06-01T00:00:00Z')),
    );
  });

  it('ignores an entry with a missing or unparseable libraryItemId', async () => {
    const { service, repository, bookService } = makeService();

    await service.batchUpdateMediaProgress(user(), [{ currentTime: 10 }, { libraryItemId: 'not-a-uuid', currentTime: 10 }]);

    expect(repository.findExposedAudioBooksByIds).not.toHaveBeenCalled();
    expect(bookService.saveAudioProgress).not.toHaveBeenCalled();
  });
});

describe('AudiobookshelfProgressService.syncLocalSessions', () => {
  it('applies accessible sessions with a single batch access lookup and returns an empty results array', async () => {
    const { service, repository, bookService } = makeService();
    vi.mocked(repository.findExposedAudioBooksByIds).mockResolvedValue([{ id: 7 }] as never);
    vi.mocked(repository.findProgressByUserIdAndBookIds).mockResolvedValue([]);

    const result = await service.syncLocalSessions(user(), [
      { libraryItemId: toAudiobookshelfUuid(7), currentTime: 40 },
      { libraryItemId: toAudiobookshelfUuid(42), currentTime: 5 },
    ]);

    expect(result).toEqual({ results: [] });
    expect(repository.findExposedAudioBooksByIds).toHaveBeenCalledTimes(1);
    expect(bookService.saveAudioProgress).toHaveBeenCalledTimes(1);
    expect(bookService.saveAudioProgress).toHaveBeenCalledWith(1, 7, expect.objectContaining({ positionSeconds: 40 }), expect.anything());
  });

  it('skips a book with no audio files rather than throwing', async () => {
    const { service, repository, bookService } = makeService();
    vi.mocked(repository.findExposedAudioBooksByIds).mockResolvedValue([{ id: 7 }] as never);
    vi.mocked(repository.findAudioFilesByBookIds).mockResolvedValue([]);

    await expect(service.syncLocalSessions(user(), [{ libraryItemId: toAudiobookshelfUuid(7), currentTime: 40 }])).resolves.toEqual({ results: [] });
    expect(bookService.saveAudioProgress).not.toHaveBeenCalled();
  });

  it('persists local session rows in a single batched call', async () => {
    const { service, repository, sessionsService } = makeService();
    vi.mocked(repository.findExposedAudioBooksByIds).mockResolvedValue([{ id: 7, libraryId: 3 }] as never);
    vi.mocked(repository.findProgressByUserIdAndBookIds).mockResolvedValue([]);

    await service.syncLocalSessions(user(), [
      {
        libraryItemId: toAudiobookshelfUuid(7),
        currentTime: 40,
        timeListening: 90,
        displayTitle: 'A Book',
        displayAuthor: 'An Author',
        duration: 3600,
        mediaPlayer: 'AVPlayer',
        deviceInfo: { deviceId: 'phone-1' },
        startedAt: Date.parse('2025-01-01T00:00:00Z'),
        updatedAt: Date.parse('2025-01-01T01:00:00Z'),
      },
    ]);

    expect(sessionsService.recordLocalSessions).toHaveBeenCalledTimes(1);
    expect(sessionsService.recordLocalSessions).toHaveBeenCalledWith(1, [
      expect.objectContaining({
        bookId: 7,
        libraryId: 3,
        displayTitle: 'A Book',
        displayAuthor: 'An Author',
        duration: 3600,
        mediaPlayer: 'AVPlayer',
        deviceInfo: { deviceId: 'phone-1' },
        timeListening: 90,
        currentTime: 40,
      }),
    ]);
  });

  it('clamps negative positions in local sessions before persisting', async () => {
    const { service, sessionsService } = makeService();

    await service.syncLocalSessions(user(), [
      { libraryItemId: toAudiobookshelfUuid(7), currentTime: -12, timeListening: 30 },
      { libraryItemId: toAudiobookshelfUuid(8), currentTime: 20, timeListening: 40 },
    ]);

    expect(sessionsService.recordLocalSessions).toHaveBeenCalledTimes(1);
    expect(sessionsService.recordLocalSessions).toHaveBeenCalledWith(1, [
      expect.objectContaining({ bookId: 7, currentTime: 0, timeListening: 30 }),
      expect.objectContaining({ bookId: 8, currentTime: 20, timeListening: 40 }),
    ]);
  });

  it('swallows a session persistence failure without failing the local sync', async () => {
    const { service, repository, sessionsService } = makeService();
    vi.mocked(repository.findExposedAudioBooksByIds).mockResolvedValue([{ id: 7, libraryId: 3 }] as never);
    vi.mocked(repository.findProgressByUserIdAndBookIds).mockResolvedValue([]);
    sessionsService.recordLocalSessions.mockRejectedValue(new Error('db unavailable'));

    await expect(
      service.syncLocalSessions(user(), [{ libraryItemId: toAudiobookshelfUuid(7), currentTime: 40, timeListening: 10 }]),
    ).resolves.toEqual({
      results: [],
    });
  });
});

describe('AudiobookshelfProgressService.deleteMediaProgress', () => {
  it('deletes progress only for the user encoded in the composite id', async () => {
    const { service, repository, itemsService } = makeService();

    await expect(service.deleteMediaProgress(user(), toAudiobookshelfCompositeUuid(1, 7))).resolves.toBeUndefined();

    expect(itemsService.requireExposedBook).toHaveBeenCalledWith(user(), 7);
    expect(repository.deleteProgressByUserIdAndBookId).toHaveBeenCalledWith(1, 7);
  });

  it('rejects a composite id belonging to another user without touching progress', async () => {
    const { service, repository, itemsService } = makeService();

    await expect(service.deleteMediaProgress(user(), toAudiobookshelfCompositeUuid(2, 7))).rejects.toThrow('Progress not found');

    expect(itemsService.requireExposedBook).not.toHaveBeenCalled();
    expect(repository.deleteProgressByUserIdAndBookId).not.toHaveBeenCalled();
  });

  it('returns not found when no progress row exists', async () => {
    const { service, repository } = makeService();
    vi.mocked(repository.deleteProgressByUserIdAndBookId).mockResolvedValue(false);

    await expect(service.deleteMediaProgress(user(), toAudiobookshelfCompositeUuid(1, 7))).rejects.toThrow('Progress not found');
  });
});
