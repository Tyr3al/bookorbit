import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { RequestUser } from '../../../common/types/request-user';
import { toAudiobookshelfUuid } from '../../../common/utils/audiobookshelf-id.utils';
import { AudiobookshelfBookmarksService } from './audiobookshelf-bookmarks.service';

const user = { id: 7, isSuperuser: false } as RequestUser;
const row = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  userId: 7,
  bookId: 42,
  cfi: null,
  title: 'Chapter 1',
  positionSeconds: 12.5,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  ...overrides,
});

function makeService() {
  const bookmarkRepository = {
    findByBookId: vi.fn(),
    findLiveAudioByTime: vi.fn(),
    createAudio: vi.fn(),
    restoreAudioAtTime: vi.fn(),
    updateAudioTitle: vi.fn(),
    softDeleteAudioAtTime: vi.fn(),
  };
  const audiobookshelfRepository = {
    findBookmarksForAudiobookshelfUser: vi.fn(),
    findExposedAudioBooksByIds: vi.fn().mockResolvedValue([{ id: 42, libraryId: 3 }]),
  };
  return {
    service: new AudiobookshelfBookmarksService(bookmarkRepository as never, audiobookshelfRepository as never),
    bookmarkRepository,
    audiobookshelfRepository,
  };
}

describe('AudiobookshelfBookmarksService', () => {
  it('returns scoped bookmarks in the ABS response shape', async () => {
    const { service, audiobookshelfRepository } = makeService();
    audiobookshelfRepository.findBookmarksForAudiobookshelfUser.mockResolvedValue([row()]);

    await expect(service.getBookmarks(user)).resolves.toEqual({
      bookmarks: [{ libraryItemId: toAudiobookshelfUuid(42), title: 'Chapter 1', time: 12.5, createdAt: Date.parse('2026-01-01T00:00:00Z') }],
    });
    expect(audiobookshelfRepository.findBookmarksForAudiobookshelfUser).toHaveBeenCalledWith(user);
  });

  it('does not expose an item from a hidden library', async () => {
    const { service, audiobookshelfRepository, bookmarkRepository } = makeService();
    audiobookshelfRepository.findExposedAudioBooksByIds.mockResolvedValue([]);

    await expect(service.getBookmarksForItem(user, 42)).rejects.toBeInstanceOf(NotFoundException);
    expect(bookmarkRepository.findByBookId).not.toHaveBeenCalled();
  });

  it('restores a tombstoned bookmark on create', async () => {
    const { service, bookmarkRepository } = makeService();
    bookmarkRepository.findLiveAudioByTime.mockResolvedValue(null);
    bookmarkRepository.createAudio.mockResolvedValue(null);
    bookmarkRepository.restoreAudioAtTime.mockResolvedValue(row({ title: 'Saved spot' }));

    await expect(service.createBookmark(user, 42, 12.5, 'Saved spot')).resolves.toMatchObject({ title: 'Saved spot', time: 12.5 });
    expect(bookmarkRepository.restoreAudioAtTime).toHaveBeenCalledWith(7, 42, 12.5, 'Saved spot');
  });

  it('updates by item and time while preserving the bookmark location', async () => {
    const { service, bookmarkRepository } = makeService();
    bookmarkRepository.findLiveAudioByTime.mockResolvedValue(row());
    bookmarkRepository.updateAudioTitle.mockResolvedValue(row({ title: 'Renamed' }));

    await expect(service.updateBookmark(user, 42, 12.5, 'Renamed')).resolves.toMatchObject({ title: 'Renamed', time: 12.5 });
    expect(bookmarkRepository.updateAudioTitle).toHaveBeenCalledWith(7, 42, 12.5, 'Renamed');
  });

  it('soft deletes by item and time', async () => {
    const { service, bookmarkRepository } = makeService();
    bookmarkRepository.softDeleteAudioAtTime.mockResolvedValue(true);

    await expect(service.deleteBookmark(user, 42, 12.5)).resolves.toBeUndefined();
    expect(bookmarkRepository.softDeleteAudioAtTime).toHaveBeenCalledWith(7, 42, 12.5);
  });
});
