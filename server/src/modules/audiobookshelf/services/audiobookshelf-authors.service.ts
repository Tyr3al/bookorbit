import { Injectable, NotFoundException } from '@nestjs/common';

import { AudiobookshelfRepository, type AbsAuthorSort } from '../audiobookshelf.repository';
import { AudiobookshelfItemsService } from './audiobookshelf-items.service';
import { AudiobookshelfLibrariesService } from './audiobookshelf-libraries.service';
import type { AbsAuthor, AbsAuthorExpanded, AbsLibraryItemMinified, AbsPaginatedAuthors } from '../audiobookshelf.types';
import type { RequestUser } from '../../../common/types/request-user';
import { toAbsSeriesUuid, toAbsUuid, fromAbsUuid } from '../../../common/utils/abs-id.utils';
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

  /** GET /api/libraries/:id/authors - authors of audio books in one library, with book counts.
   * Real ABS's response shape depends on whether the request carries pagination params: with
   * `limit` (and optionally `page`) it returns the paginated envelope below; without `limit` -
   * e.g. a plain listing request with just `sort`/`desc` - it returns a bare `{ authors: [] }`
   * with no pagination metadata at all. Some ABS clients (confirmed with "Still") never send
   * `limit`/`page` and fail to decode the paginated shape, since it has no `authors` key. */
  async listLibraryAuthors(
    user: RequestUser,
    libraryId: number,
    limit?: number,
    page?: number,
    sort: AbsAuthorSort = 'name',
    sortDesc = false,
    filter?: string,
    minified = false,
    include?: string,
  ): Promise<{ authors: AbsAuthor[] } | AbsPaginatedAuthors> {
    await this.librariesService.requireExposedLibrary(user, libraryId);
    const contentFilters = user.isSuperuser ? undefined : user.contentFilters;

    if (limit === undefined) {
      const rows = await this.repository.findAuthorsWithCountsByLibraries([libraryId], contentFilters);
      const authors = rows.map((row) => this.toAuthor(row, toAbsUuid(libraryId), row.numBooks));
      return { authors };
    }

    const effectivePage = page ?? 0;
    const offset = effectivePage * limit;
    const pageResult = await this.repository.findAuthorsWithCountsByLibrariesPage([libraryId], contentFilters, limit, offset, sort, sortDesc);
    const authors = pageResult.rows.map((row) => this.toAuthor(row, toAbsUuid(libraryId), row.numBooks));
    return {
      results: authors,
      total: pageResult.total,
      limit,
      page: effectivePage,
      sortBy: sort,
      sortDesc,
      filterBy: filter,
      minified,
      include: normalizeInclude(include),
    };
  }

  /** GET /api/authors/:id and /api/libraries/:libraryId/authors/:id. */
  async getAuthor(user: RequestUser, authorId: number, include?: string, libraryId?: number): Promise<AbsAuthorExpanded | AbsAuthor> {
    const [author] = await this.repository.findAuthorsByIds([authorId]);
    if (!author) throw new NotFoundException(`Author ${authorId} not found`);

    if (libraryId !== undefined) await this.librariesService.requireExposedLibrary(user, libraryId);
    const contentFilters = user.isSuperuser ? undefined : user.contentFilters;
    const libraryIds = libraryId === undefined ? await this.librariesService.getExposedLibraryIds(user) : [libraryId];
    const exposedBookIds = new Set(await this.repository.findAudioBookIdsByLibraries(libraryIds, contentFilters));
    const links = await this.repository.findAuthorIdsByBookIds([...exposedBookIds]);
    const bookIds = links.filter((link) => link.authorId === authorId && exposedBookIds.has(link.bookId)).map((link) => link.bookId);
    if (bookIds.length === 0) throw new NotFoundException(`Author ${authorId} not found`);

    const wantsItems = include?.split(',').includes('items') ?? false;
    const wantsSeries = include?.split(',').includes('series') ?? false;
    const responseLibraryId = libraryId !== undefined ? toAbsUuid(libraryId) : await this.resolveAuthorLibraryId(bookIds);
    if (!wantsItems && !wantsSeries) {
      return this.toAuthor(author, responseLibraryId);
    }

    const items = await this.itemsService.getMinifiedItemsByIds(bookIds);
    const expandedLibraryId = items[0]?.libraryId ?? responseLibraryId;

    const result: AbsAuthorExpanded = {
      ...this.toAuthor(author, expandedLibraryId),
      libraryItems: items,
      series: wantsSeries ? await this.groupItemsBySeries(items, bookIds) : [],
    };
    return result;
  }

  private async resolveAuthorLibraryId(bookIds: number[]): Promise<string | undefined> {
    if (bookIds.length > 0) {
      const [book] = await this.repository.findBooksByIds([bookIds[0]]);
      if (book) return toAbsUuid(book.libraryId);
    }
    return undefined;
  }

  private toAuthor(
    author: { id: number; name: string; description: string | null; sortName: string | null; hasPhoto?: boolean },
    libraryId?: string,
    numBooks?: number,
  ): AbsAuthor {
    // Real ABS only includes lastFirst (and numBooks) on the library-scoped list shape, not on
    // the single-author detail fetch - keyed off numBooks since both are set together there.
    const isListContext = numBooks !== undefined;
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
      ...(isListContext ? { lastFirst: author.sortName ?? author.name } : {}),
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
      const seriesId = toAbsSeriesUuid(membership.id);
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

function normalizeInclude(value: string | undefined): string {
  return (value ?? '')
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
    .join(',');
}
