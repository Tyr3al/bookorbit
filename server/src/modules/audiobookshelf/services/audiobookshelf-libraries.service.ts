import { Injectable, NotFoundException } from '@nestjs/common';
import type { ContentFilterRules } from '@bookorbit/types';

import { AudiobookshelfRepository, type AbsItemPageQuery, type AbsItemSort } from '../audiobookshelf.repository';
import { ABS_DEFAULT_ITEM_LIMIT, ABS_MAX_ITEM_LIMIT, ABS_PROVIDER, ABS_METADATA_PRECEDENCE } from '../audiobookshelf.constants';
import type {
  AbsAuthor,
  AbsLibrary,
  AbsLibraryFilterData,
  AbsLibraryItem,
  AbsLibraryItemMinified,
  AbsPaginatedItems,
  AbsPersonalizedShelf,
  AbsSeries,
} from '../audiobookshelf.types';
import { AudiobookshelfItemsService } from './audiobookshelf-items.service';
import type { RequestUser } from '../../../common/types/request-user';
import { fromAbsUuid, toAbsSeriesUuid, toAbsUuid } from '../../../common/utils/abs-id.utils';

/** Minimal user shape the library-scoped ABS queries need. */
export type AbsLibraryUser = Pick<RequestUser, 'id' | 'isSuperuser'>;

export interface AbsItemsPageInput {
  limit?: number;
  page?: number;
  sort?: string;
  desc?: string;
  search?: string;
  filter?: string;
  include?: string;
  minified?: string;
  collapseseries?: string;
}

export interface AbsLibraryDetailWithFilterData {
  library: AbsLibrary;
  filterdata: AbsLibraryFilterData;
  issues: number;
  numUserPlaylists: number;
}

/** GET /api/libraries/:id/search response shape, matching real ABS's
 * `libraryItemsBookFilters.search()`. `authors` is plural (not `author`), and there is no
 * `podcast`/`episode` key for a book library. */
export interface AbsLibrarySearchResult {
  book: { libraryItem: AbsLibraryItem }[];
  narrators: { name: string; numBooks: number }[];
  tags: { name: string; numItems: number }[];
  genres: { name: string; numItems: number }[];
  series: { series: AbsSeries; books: AbsLibraryItemMinified[] }[];
  authors: AbsAuthor[];
}

@Injectable()
export class AudiobookshelfLibrariesService {
  constructor(
    private readonly repository: AudiobookshelfRepository,
    private readonly itemsService: AudiobookshelfItemsService,
  ) {}

  /** Libraries the user can see through the ABS API (opted in + accessible). */
  async findLibraries(user: AbsLibraryUser): Promise<{ libraries: AbsLibrary[] }> {
    const libraries = await this.repository.findOptedInLibraries(user.id, user.isSuperuser);
    if (libraries.length === 0) return { libraries: [] };

    const folders = await this.repository.findFoldersByLibraryIds(libraries.map((library) => library.id));
    const foldersByLibraryId = new Map<number, typeof folders>();
    for (const folder of folders) {
      const list = foldersByLibraryId.get(folder.libraryId);
      if (list) list.push(folder);
      else foldersByLibraryId.set(folder.libraryId, [folder]);
    }

    return {
      libraries: libraries.map((library) => this.mapLibrary(library, foldersByLibraryId.get(library.id) ?? [])),
    };
  }

  /** GET /api/libraries/:id. The filterdata variant mirrors ABS's expanded library envelope. */
  async getLibrary(user: RequestUser, libraryId: number, include?: string): Promise<AbsLibrary | AbsLibraryDetailWithFilterData> {
    await this.requireExposedLibrary(user, libraryId);
    const library = await this.repository.findLibraryById(libraryId);
    if (!library) throw new NotFoundException(`Library ${libraryId} not found`);
    const folders = await this.repository.findFoldersByLibraryIds([libraryId]);
    const mappedLibrary = this.mapLibrary(library, folders);
    if (!hasInclude(include, 'filterdata')) return mappedLibrary;

    const filterdata = await this.getFilterData(user, libraryId);
    return { library: mappedLibrary, filterdata, issues: filterdata.numIssues, numUserPlaylists: 0 };
  }

  /** Paginated audio items of one library (Prologue pages through with limit=10). */
  async getItemsPage(user: RequestUser, libraryId: number, input: AbsItemsPageInput): Promise<AbsPaginatedItems> {
    await this.requireExposedLibrary(user, libraryId);

    const limit = clampLimit(input.limit);
    const page = clampPage(input.page);
    const sort = normalizeSort(input.sort);
    const contentFilters = user.isSuperuser ? undefined : user.contentFilters;
    const query: AbsItemPageQuery = {
      limit,
      offset: page * limit,
      sort,
      desc: input.desc === '1' || input.desc === 'true',
      search: input.search?.trim() ? input.search.trim() : undefined,
      filter: input.filter,
    };

    const total = await this.repository.countAudioBooks(libraryId, query.search, contentFilters, query.filter);
    const bookIds = await this.repository.findAudioBookIds(libraryId, query, contentFilters);
    const items = await this.itemsService.getMinifiedItemsByIds(bookIds);
    return {
      results: items,
      total,
      limit,
      page,
      sortBy: input.sort,
      sortDesc: query.desc ?? false,
      filterBy: input.filter,
      mediaType: 'book',
      minified: true,
      collapseseries: input.collapseseries === '1' || input.collapseseries === 'true',
      include: normalizeInclude(input.include),
      offset: page * limit,
    };
  }

  /** GET /api/libraries/:id/personalized. Keep shelf queries bounded and library-scoped. */
  async getPersonalized(user: RequestUser, libraryId: number, requestedLimit?: number): Promise<AbsPersonalizedShelf[]> {
    await this.requireExposedLibrary(user, libraryId);

    const limit = clampLimit(requestedLimit);
    const contentFilters = user.isSuperuser ? undefined : user.contentFilters;
    const [progressRows, progressTotal, recentBookIds, recentTotal] = await Promise.all([
      this.repository.findItemsInProgressForAudiobookshelfUser(user, limit, libraryId),
      this.repository.countItemsInProgressForAudiobookshelfUser(user, libraryId),
      this.repository.findAudioBookIds(libraryId, { limit, offset: 0, sort: 'addedAt', desc: true }, contentFilters),
      this.repository.countAudioBooks(libraryId, undefined, contentFilters),
    ]);
    const [progressItems, recentItems] = await Promise.all([
      this.itemsService.getMinifiedItemsByIds(progressRows.map((row) => row.bookId)),
      this.itemsService.getMinifiedItemsByIds(recentBookIds),
    ]);

    const progressItemsById = new Map(progressItems.map((item) => [item.id, item]));
    const continueListening = progressRows.flatMap((row) => {
      const item = progressItemsById.get(toAbsUuid(row.bookId));
      return item ? [{ ...item, progressLastUpdate: row.progressLastUpdate.getTime() }] : [];
    });

    const shelves: AbsPersonalizedShelf[] = [];
    if (continueListening.length > 0) {
      shelves.push({
        id: 'continue-listening',
        label: 'Continue Listening',
        labelStringKey: 'LabelContinueListening',
        type: 'book',
        entities: continueListening,
        total: progressTotal,
      });
    }
    if (recentItems.length > 0) {
      shelves.push({
        id: 'recently-added',
        label: 'Recently Added',
        labelStringKey: 'LabelRecentlyAdded',
        type: 'book',
        entities: recentItems,
        total: recentTotal,
      });
    }
    return shelves;
  }

  /** GET /api/libraries/:id/search - mirrors real ABS's `libraryItemsBookFilters.search()`:
   * books (expanded, `{ libraryItem }` wrapped), narrators/tags/genres with counts, series with
   * their accessible books (series with none are dropped), and authors with book counts. Every
   * category is matched and LIMITed independently in SQL - none of this loads a library's full
   * book/author/series set into memory. */
  async searchLibrary(user: RequestUser, libraryId: number, q: string, requestedLimit?: number): Promise<AbsLibrarySearchResult> {
    await this.requireExposedLibrary(user, libraryId);
    const limit = clampLimit(requestedLimit);
    const contentFilters = user.isSuperuser ? undefined : user.contentFilters;
    const absLibraryId = toAbsUuid(libraryId);

    const [bookIds, seriesPage, authorsPage, narratorRows, genreRows, tagRows] = await Promise.all([
      this.repository.findAudioBookSearchIds(libraryId, q, limit, contentFilters),
      this.repository.findSeriesByLibrariesPage([libraryId], contentFilters, limit, 0, 'name', false, q),
      this.repository.findAuthorsWithCountsByLibrariesPage([libraryId], contentFilters, limit, 0, 'name', false, q),
      this.repository.findNarratorsWithCountsByLibraries([libraryId], contentFilters, q, limit),
      this.repository.findGenresWithCountsByLibraries([libraryId], contentFilters, q, limit),
      this.repository.findTagsWithCountsByLibraries([libraryId], contentFilters, q, limit),
    ]);

    const [bookItems, seriesBooksBySeriesId] = await Promise.all([
      this.itemsService.getItemsByIds(bookIds),
      this.resolveSeriesBooks(
        seriesPage.rows.map((row) => row.id),
        libraryId,
        contentFilters,
      ),
    ]);

    const series = seriesPage.rows
      .map((row) => ({ series: this.toSearchSeries(row, absLibraryId), books: seriesBooksBySeriesId.get(row.id) ?? [] }))
      .filter((entry) => entry.books.length > 0);

    return {
      book: bookItems.map((libraryItem) => ({ libraryItem })),
      narrators: narratorRows.map((row) => ({ name: row.name, numBooks: row.numBooks })),
      tags: tagRows.map((row) => ({ name: row.name, numItems: row.numItems })),
      genres: genreRows.map((row) => ({ name: row.name, numItems: row.numItems })),
      series,
      authors: authorsPage.rows.map((row) => this.toSearchAuthor(row, absLibraryId)),
    };
  }

  /** Accessible book ids per matched series, keyed by series id. Reuses the same
   * membership+minified-item lookup {@link AudiobookshelfSeriesService.listLibrarySeries} uses,
   * bounded because the series set itself is already limit-bounded. */
  private async resolveSeriesBooks(
    seriesIds: number[],
    libraryId: number,
    contentFilters?: ContentFilterRules,
  ): Promise<Map<number, AbsLibraryItemMinified[]>> {
    if (seriesIds.length === 0) return new Map();
    const memberships = await this.repository.findSeriesMembershipBookIdsByLibraries(seriesIds, [libraryId], contentFilters);
    const bookIdsBySeriesId = new Map<number, number[]>();
    for (const membership of memberships) {
      const list = bookIdsBySeriesId.get(membership.seriesId);
      if (list) list.push(membership.bookId);
      else bookIdsBySeriesId.set(membership.seriesId, [membership.bookId]);
    }
    const allBookIds = [...bookIdsBySeriesId.values()].flat();
    const itemsByBookId = new Map((await this.itemsService.getMinifiedItemsByIds(allBookIds)).map((item) => [fromAbsUuid(item.id), item] as const));

    const result = new Map<number, AbsLibraryItemMinified[]>();
    for (const [seriesId, bookIds] of bookIdsBySeriesId) {
      result.set(
        seriesId,
        bookIds.map((bookId) => itemsByBookId.get(bookId)).filter((item): item is AbsLibraryItemMinified => item != null),
      );
    }
    return result;
  }

  private toSearchSeries(series: { id: number; name: string; createdAt?: Date; updatedAt?: Date }, libraryId: string): AbsSeries {
    return {
      id: toAbsSeriesUuid(series.id),
      name: series.name,
      nameIgnorePrefix: series.name,
      description: null,
      addedAt: series.createdAt?.getTime() ?? 0,
      updatedAt: series.updatedAt?.getTime() ?? 0,
      libraryId,
    };
  }

  private toSearchAuthor(
    author: { id: number; name: string; description: string | null; sortName: string | null; hasPhoto?: boolean; numBooks: number },
    libraryId: string,
  ): AbsAuthor {
    return {
      id: toAbsUuid(author.id),
      asin: null,
      name: author.name,
      description: author.description,
      imagePath: author.hasPhoto ? `/authors/${author.id}/photo.jpg` : null,
      addedAt: 0,
      updatedAt: 0,
      libraryId,
      numBooks: author.numBooks,
      lastFirst: author.sortName ?? author.name,
    };
  }

  /** GET /api/libraries/:id/filterdata - a library's capability summary. Some ABS clients
   * (confirmed with Prologue) check this to decide what's worth syncing before ever calling the
   * dedicated series/genre/etc. list endpoints, so an unimplemented (or wrong) response here can
   * make a library look empty of series/genres/etc. persistently, even though those endpoints
   * work fine on their own. */
  async getFilterData(user: RequestUser, libraryId: number): Promise<AbsLibraryFilterData> {
    await this.requireExposedLibrary(user, libraryId);
    const contentFilters = user.isSuperuser ? undefined : user.contentFilters;

    const [library, authorRows, seriesRows, narratorRows, bookCount, aggregates] = await Promise.all([
      this.repository.findLibraryById(libraryId),
      this.repository.findAuthorsWithCountsByLibraries([libraryId], contentFilters),
      this.repository.findSeriesByLibraries([libraryId], contentFilters),
      this.repository.findNarratorsWithCountsByLibraries([libraryId], contentFilters),
      this.repository.countAudioBooksByLibraries([libraryId], contentFilters),
      this.repository.findLibraryFilterAggregates([libraryId], contentFilters),
    ]);
    if (!library) throw new NotFoundException(`Library ${libraryId} not found`);

    return {
      authors: authorRows.map((row) => ({ id: toAbsUuid(row.id), name: row.name })),
      genres: aggregates.genres,
      tags: [],
      series: seriesRows.map((row) => ({ id: toAbsSeriesUuid(row.id), name: row.name })),
      narrators: narratorRows.map((row) => row.name),
      languages: aggregates.languages,
      publishers: aggregates.publishers,
      publishedDecades: [...new Set(aggregates.publishedYears.map((year) => String(Math.floor(year / 10) * 10)))].sort(),
      bookCount,
      authorCount: authorRows.length,
      seriesCount: seriesRows.length,
      podcastCount: 0,
      numIssues: aggregates.missingCount,
      loadedAt: library.updatedAt.getTime(),
    };
  }

  /** Ids of all libraries exposed to the user (used by author/series/collection scoping). */
  async getExposedLibraryIds(user: AbsLibraryUser): Promise<number[]> {
    const libraries = await this.repository.findOptedInLibraries(user.id, user.isSuperuser);
    return libraries.map((library) => library.id);
  }

  /** 404 unless the library is opted in and the user can access it. */
  async requireExposedLibrary(user: AbsLibraryUser, libraryId: number): Promise<void> {
    const exposed = await this.repository.isLibraryExposedForUser(libraryId, user.id, user.isSuperuser);
    if (!exposed) throw new NotFoundException(`Library ${libraryId} not found`);
  }

  private mapLibrary(
    library: Awaited<ReturnType<AudiobookshelfRepository['findLibraryById']>> extends infer T ? Exclude<T, undefined> : never,
    folders: Awaited<ReturnType<AudiobookshelfRepository['findFoldersByLibraryIds']>>,
  ): AbsLibrary {
    return {
      id: toAbsUuid(library.id),
      name: library.name,
      folders: folders
        .filter((folder) => folder.libraryId === library.id)
        .map((folder) => ({
          id: toAbsUuid(folder.id),
          fullPath: folder.path,
          libraryId: toAbsUuid(library.id),
          addedAt: folder.createdAt.getTime(),
        })),
      displayOrder: library.displayOrder,
      icon: 'database',
      mediaType: 'book',
      provider: ABS_PROVIDER,
      settings: {
        coverAspectRatio: 1,
        disableWatcher: !library.watch,
        autoScanCronExpression: library.autoScanCronExpression,
        skipMatchingMediaWithAsin: false,
        skipMatchingMediaWithIsbn: false,
        audiobooksOnly: true,
        epubsAllowScriptedContent: false,
        hideSingleBookSeries: false,
        onlyShowLaterBooksInContinueSeries: false,
        metadataPrecedence: [...ABS_METADATA_PRECEDENCE],
        markAsFinishedPercentComplete: null,
        markAsFinishedTimeRemaining: 10,
      },
      lastScan: library.updatedAt.getTime(),
      lastScanVersion: '2.36.0',
      createdAt: library.createdAt.getTime(),
      lastUpdate: library.updatedAt.getTime(),
    };
  }
}

function hasInclude(value: string | undefined, requested: string): boolean {
  return (value ?? '').split(',').some((part) => part.trim().toLowerCase() === requested);
}

function clampLimit(value: number | undefined): number {
  if (value == null || !Number.isFinite(value) || value < 1) return ABS_DEFAULT_ITEM_LIMIT;
  return Math.min(Math.floor(value), ABS_MAX_ITEM_LIMIT);
}

function clampPage(value: number | undefined): number {
  if (value == null || !Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

function normalizeSort(value: string | undefined): AbsItemSort {
  switch (value) {
    case 'author':
    case 'media.metadata.authorName':
      return 'author';
    case 'addedAt':
    case 'updatedAt':
      return value;
    case 'duration':
    case 'media.duration':
      return 'duration';
    case 'size':
    case 'media.size':
      return 'size';
    case 'publishedYear':
    case 'media.metadata.publishedYear':
      return 'publishedYear';
    case 'media.metadata.title':
    case 'title':
    default:
      return 'title';
  }
}

function normalizeInclude(value: string | undefined): string {
  return (value ?? '')
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
    .join(',');
}
