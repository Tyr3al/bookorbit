import { Injectable, NotFoundException } from '@nestjs/common';

import { AudiobookshelfRepository, type AbsItemPageQuery, type AbsItemSort } from '../audiobookshelf.repository';
import { ABS_DEFAULT_ITEM_LIMIT, ABS_MAX_ITEM_LIMIT, ABS_PROVIDER, ABS_METADATA_PRECEDENCE } from '../audiobookshelf.constants';
import type { AbsLibrary, AbsLibraryFilterData, AbsLibraryItemMinified, AbsPaginatedItems, AbsPersonalizedShelf } from '../audiobookshelf.types';
import { AudiobookshelfItemsService } from './audiobookshelf-items.service';
import type { RequestUser } from '../../../common/types/request-user';
import { toAbsSeriesUuid, toAbsUuid } from '../../../common/utils/abs-id.utils';

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

  /** ABS /api/libraries/:id/search - book results only; other entity keys are empty for now. */
  async searchLibrary(
    user: RequestUser,
    libraryId: number,
    q?: string,
    input?: AbsItemsPageInput,
  ): Promise<{ book: AbsLibraryItemMinified[]; author: unknown[]; series: unknown[]; podcast: unknown[]; episode: unknown[] }> {
    const page = await this.getItemsPage(user, libraryId, { ...input, search: q });
    return { book: page.results, author: [], series: [], podcast: [], episode: [] };
  }

  /** GET /api/libraries/:id/filterdata - a library's capability summary. Some ABS clients
   * (confirmed with Prologue) check this to decide what's worth syncing before ever calling the
   * dedicated series/genre/etc. list endpoints, so an unimplemented (or wrong) response here can
   * make a library look empty of series/genres/etc. persistently, even though those endpoints
   * work fine on their own. */
  async getFilterData(user: RequestUser, libraryId: number): Promise<AbsLibraryFilterData> {
    await this.requireExposedLibrary(user, libraryId);
    const contentFilters = user.isSuperuser ? undefined : user.contentFilters;

    const [authorRows, seriesRows, narratorRows, bookIds, aggregates] = await Promise.all([
      this.repository.findAuthorsWithCountsByLibraries([libraryId], contentFilters),
      this.repository.findSeriesByLibraries([libraryId], contentFilters),
      this.repository.findNarratorsWithCountsByLibraries([libraryId], contentFilters),
      this.repository.findAudioBookIdsByLibraries([libraryId], contentFilters),
      this.repository.findLibraryFilterAggregates([libraryId], contentFilters),
    ]);

    return {
      authors: authorRows.map((row) => ({ id: toAbsUuid(row.id), name: row.name })),
      genres: aggregates.genres,
      tags: [],
      series: seriesRows.map((row) => ({ id: toAbsSeriesUuid(row.id), name: row.name })),
      narrators: narratorRows.map((row) => row.name),
      languages: aggregates.languages,
      publishers: aggregates.publishers,
      publishedDecades: [...new Set(aggregates.publishedYears.map((year) => String(Math.floor(year / 10) * 10)))].sort(),
      bookCount: bookIds.length,
      authorCount: authorRows.length,
      seriesCount: seriesRows.length,
      podcastCount: 0,
      numIssues: aggregates.missingCount,
      loadedAt: Date.now(),
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
