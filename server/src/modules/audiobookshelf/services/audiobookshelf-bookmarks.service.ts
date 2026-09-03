import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';

import type { RequestUser } from '../../../common/types/request-user';
import { toAudiobookshelfUuid } from '../../../common/utils/audiobookshelf-id.utils';
import { BookmarkRepository } from '../../bookmark/bookmark.repository';
import { AudiobookshelfRepository } from '../audiobookshelf.repository';

export interface AudiobookshelfBookmark {
  libraryItemId: string;
  title: string;
  time: number;
  createdAt: number;
}

type AudiobookshelfBookmarkUser = Pick<RequestUser, 'id' | 'isSuperuser'> & { contentFilters?: RequestUser['contentFilters'] };

@Injectable()
export class AudiobookshelfBookmarksService {
  constructor(
    private readonly bookmarkRepository: BookmarkRepository,
    private readonly audiobookshelfRepository: AudiobookshelfRepository,
  ) {}

  async getBookmarks(user: AudiobookshelfBookmarkUser): Promise<{ bookmarks: AudiobookshelfBookmark[] }> {
    const rows = await this.audiobookshelfRepository.findBookmarksForAudiobookshelfUser(user);
    return { bookmarks: rows.map((row) => this.toAudiobookshelfBookmark(row)) };
  }

  async getBookmarksForItem(user: RequestUser, bookId: number): Promise<{ bookmarks: AudiobookshelfBookmark[] }> {
    await this.requireExposedBook(user, bookId);
    const rows = await this.bookmarkRepository.findByBookId(bookId, user.id);
    return { bookmarks: rows.filter((row) => row.positionSeconds !== null).map((row) => this.toAudiobookshelfBookmark(row)) };
  }

  async createBookmark(user: RequestUser, bookId: number, time: number, title: string): Promise<AudiobookshelfBookmark> {
    await this.requireExposedBook(user, bookId);
    const existing = await this.bookmarkRepository.findLiveAudioByTime(user.id, bookId, time);
    if (existing) return this.toAudiobookshelfBookmark(existing);

    const created = await this.bookmarkRepository.createAudio(user.id, bookId, time, title);
    if (created) return this.toAudiobookshelfBookmark(created);

    const restored = await this.bookmarkRepository.restoreAudioAtTime(user.id, bookId, time, title);
    if (restored) return this.toAudiobookshelfBookmark(restored);

    const concurrent = await this.bookmarkRepository.findLiveAudioByTime(user.id, bookId, time);
    if (concurrent) return this.toAudiobookshelfBookmark(concurrent);
    throw new ConflictException('Unable to create bookmark');
  }

  async updateBookmark(user: RequestUser, bookId: number, time: number, title: string): Promise<AudiobookshelfBookmark> {
    await this.requireExposedBook(user, bookId);
    const existing = await this.bookmarkRepository.findLiveAudioByTime(user.id, bookId, time);
    if (!existing) throw new NotFoundException('Bookmark not found');
    const updated = await this.bookmarkRepository.updateAudioTitle(user.id, bookId, time, title);
    return this.toAudiobookshelfBookmark(updated ?? existing);
  }

  async deleteBookmark(user: RequestUser, bookId: number, time: number): Promise<void> {
    await this.requireExposedBook(user, bookId);
    const deleted = await this.bookmarkRepository.softDeleteAudioAtTime(user.id, bookId, time);
    if (!deleted) throw new NotFoundException('Bookmark not found');
  }

  private async requireExposedBook(user: RequestUser, bookId: number): Promise<void> {
    const [book] = await this.audiobookshelfRepository.findExposedAudioBooksByIds([bookId], user);
    if (!book) {
      throw new NotFoundException(`Book ${bookId} not found`);
    }
  }

  private toAudiobookshelfBookmark(row: { bookId: number; title: string; positionSeconds: number | null; createdAt: Date }): AudiobookshelfBookmark {
    return {
      libraryItemId: toAudiobookshelfUuid(row.bookId),
      title: row.title,
      time: row.positionSeconds ?? 0,
      createdAt: row.createdAt.getTime(),
    };
  }
}
