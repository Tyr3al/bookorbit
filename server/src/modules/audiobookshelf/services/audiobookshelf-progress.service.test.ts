import { describe, expect, it, vi } from 'vitest';

import { AudiobookshelfProgressService } from './audiobookshelf-progress.service';
import type { AudiobookshelfRepository } from '../audiobookshelf.repository';
import type { AudiobookshelfItemsService } from './audiobookshelf-items.service';
import type { BookService } from '../book/book.service';
import type { BookFile } from '../../db/schema';
import type { RequestUser } from '../../common/types/request-user';
import { toAbsUuid } from '../../../common/utils/abs-id.utils';

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
    findProgressByUserIdAndBookIds: vi
      .fn()
      .mockResolvedValue([
        { userId: 1, bookId: 7, percentage: 25, currentFileId: 11, positionSeconds: 10, updatedAt: new Date('2024-01-01T00:00:00Z') },
      ]),
    findAudioFilesByBookId: vi.fn().mockResolvedValue(files),
  } as unknown as AudiobookshelfRepository;
  const itemsService = { requireExposedBook: vi.fn().mockResolvedValue({ id: 7 }) } as unknown as AudiobookshelfItemsService;
  const bookService = { saveAudioProgress: vi.fn().mockResolvedValue(undefined) } as unknown as BookService;

  const service = new AudiobookshelfProgressService(repository, bookService, itemsService);
  return { service, repository, bookService, itemsService };
}

describe('AudiobookshelfProgressService.getMediaProgressForUser', () => {
  it('queries progress through the ABS visibility scope', async () => {
    const { service, repository } = makeService();
    await service.getMediaProgressForUser(user());

    expect(repository.findProgressForAudiobookshelfUser).toHaveBeenCalledWith(user());
  });
});

describe('AudiobookshelfProgressService.toMediaProgress', () => {
  it('computes the absolute position across files and the progress fraction', () => {
    const { service } = makeService();
    const row = { userId: 1, bookId: 7, percentage: 25, currentFileId: 12, positionSeconds: 10, updatedAt: new Date('2024-01-01T00:00:00Z') };
    const progress = service.toMediaProgress(row, [audioFile(), audioFile({ id: 12, sortOrder: 1, durationSeconds: 60 })]);

    expect(progress.progress).toBe(0.25);
    expect(progress.currentTime).toBe(70);
    expect(progress.duration).toBe(120);
    expect(progress.isFinished).toBe(false);
    expect(progress.libraryItemId).toBe(toAbsUuid(7));
    expect(progress.mediaItemType).toBe('book');
  });

  it('marks progress as finished at the ABS threshold', () => {
    const { service } = makeService();
    const progress = service.toMediaProgress(
      { userId: 1, bookId: 7, percentage: 99, currentFileId: 12, positionSeconds: 0, updatedAt: new Date('2024-01-01T00:00:00Z') },
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
});
