import { Injectable } from '@nestjs/common';

import { AudiobookshelfRepository } from '../audiobookshelf.repository';
import { AudiobookshelfLibrariesService } from './audiobookshelf-libraries.service';
import type { AudiobookshelfLibraryNarrators } from '../audiobookshelf.types';
import type { RequestUser } from '../../../common/types/request-user';

@Injectable()
export class AudiobookshelfNarratorsService {
  constructor(
    private readonly repository: AudiobookshelfRepository,
    private readonly librariesService: AudiobookshelfLibrariesService,
  ) {}

  /** GET /api/libraries/:id/narrators - narrators of audio books in one library, with book
   * counts. Real ABS always returns this bare shape (no pagination envelope, ignores
   * limit/page) - narrators aren't real entities, so each `id` is just the base64-encoded,
   * URI-encoded name, ready to drop straight into `filter=narrators.<id>`. */
  async listLibraryNarrators(user: RequestUser, libraryId: number): Promise<AudiobookshelfLibraryNarrators> {
    await this.librariesService.requireExposedLibrary(user, libraryId);
    const contentFilters = user.isSuperuser ? undefined : user.contentFilters;
    const rows = await this.repository.findNarratorsWithCountsByLibraries([libraryId], contentFilters);
    return {
      narrators: rows.map((row) => ({
        id: encodeURIComponent(Buffer.from(row.name).toString('base64')),
        name: row.name,
        numBooks: row.numBooks,
      })),
    };
  }
}
