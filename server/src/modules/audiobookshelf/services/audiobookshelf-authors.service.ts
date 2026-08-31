import { Injectable, NotFoundException } from '@nestjs/common';

import { AudiobookshelfRepository } from '../audiobookshelf.repository';
import { AudiobookshelfItemsService } from './audiobookshelf-items.service';
import { AudiobookshelfLibrariesService } from './audiobookshelf-libraries.service';
import type { AbsAuthor, AbsAuthorExpanded, AbsLibraryItemMinified, AbsPaginatedAuthors } from '../audiobookshelf.types';
import type { RequestUser } from '../../../common/types/request-user';
import { toAbsUuid, fromAbsUuid } from '../../../common/utils/abs-id.utils';
import { AuthorsService } from '../../authors/authors.service';

@Injectable()
export class AudiobookshelfAuthorsService {
  constructor(
    private readonly repository: AudiobookshelfRepository,
    private readonly itemsService: AudiobookshelfItemsService,
    private readonly librariesService: AudiobookshelfLibrariesService,
    private readonly authorsService: AuthorsService,
  ) {}

  /** GET /api/authors/:id/image */
  async getImagePath(user: RequestUser, authorId: number): Promise<string | null> {
    return this.authorsService.getImagePath(user, authorId);
  }

  /** GET /api/libraries/:id/authors - authors of audio books in one library, with book counts. */
  async listLibraryAuthors(user: RequestUser, libraryId: number, limit = 50, page = 0): Promise<AbsPaginatedAuthors> {
    await this.librariesService.requireExposedLibrary(user, libraryId);
    const contentFilters = user.isSuperuser ? undefined : user.contentFilters;
    const rows = await this.repository.findAuthorsWithCountsByLibraries([libraryId], contentFilters);
    const offset = page * limit;
    const pageRows = rows.slice(offset, offset + limit);
    return {
      results: pageRows.map((row) => this.toAuthor(row, toAbsUuid(libraryId), row.numBooks)),
      total: rows.length,
      limit,
      page,
      sortDesc: false,
      minified: false,
    };
  }

  /** GET /api/authors/:id - optionally with include=items,series. */
  async getAuthor(user: RequestUser, authorId: number, include?: string): Promise<AbsAuthorExpanded | AbsAuthor> {
    const [author] = await this.repository.findAuthorsByIds([authorId]);
    if (!author) throw new NotFoundException(`Author ${authorId} not found`);

    const wantsItems = include?.split(',').includes('items') ?? false;
    const wantsSeries = include?.split(',').includes('series') ?? false;
    if (!wantsItems && !wantsSeries) {
      return this.toAuthor(author);
    }

    const contentFilters = user.isSuperuser ? undefined : user.contentFilters;
    const libraryIds = await this.librariesService.getExposedLibraryIds(user);
    const exposedBookIds = new Set(await this.repository.findAudioBookIdsByLibraries(libraryIds, contentFilters));
    const links = await this.repository.findAuthorIdsByBookIds([...exposedBookIds]);
    const bookIds = links.filter((link) => link.authorId === authorId && exposedBookIds.has(link.bookId)).map((link) => link.bookId);
    const items = await this.itemsService.getMinifiedItemsByIds(bookIds);

    const result: AbsAuthorExpanded = {
      ...this.toAuthor(author),
      libraryItems: items,
      series: wantsSeries ? await this.groupItemsBySeries(items, bookIds) : [],
    };
    return result;
  }

  private toAuthor(
    author: { id: number; name: string; description: string | null; sortName: string | null; hasPhoto?: boolean },
    libraryId?: string,
    numBooks?: number,
  ): AbsAuthor {
    return {
      id: toAbsUuid(author.id),
      asin: null,
      name: author.name,
      description: author.description,
      imagePath: author.hasPhoto ? `/authors/${author.id}/photo.jpg` : null,
      addedAt: 0,
      updatedAt: 0,
      ...(libraryId !== undefined ? { libraryId } : {}),
      ...(numBooks !== undefined ? { numBooks } : {}),
      lastFirst: author.sortName ?? author.name,
    };
  }

  /** Minified items don't carry per-series ids (only a flattened seriesName), so series
   * membership is looked up separately rather than parsed off the mapped item. */
  private async groupItemsBySeries(
    items: AbsLibraryItemMinified[],
    bookIds: number[],
  ): Promise<{ id: string; name: string; items: AbsLibraryItemMinified[] }[]> {
    const memberships = await this.repository.findSeriesByBookIds(bookIds);
    const itemsByBookId = new Map(items.map((item) => [fromAbsUuid(item.id), item] as const));

    const seriesMap = new Map<string, { id: string; name: string; items: AbsLibraryItemMinified[] }>();
    for (const membership of memberships) {
      const item = itemsByBookId.get(membership.bookId);
      if (!item) continue;
      const seriesId = toAbsUuid(membership.id);
      let entry = seriesMap.get(seriesId);
      if (!entry) {
        entry = { id: seriesId, name: membership.name, items: [] };
        seriesMap.set(seriesId, entry);
      }
      entry.items.push(item);
    }
    return [...seriesMap.values()];
  }
}
