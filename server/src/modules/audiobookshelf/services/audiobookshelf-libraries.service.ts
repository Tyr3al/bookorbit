import { Injectable, NotFoundException } from '@nestjs/common';

import { AudiobookshelfRepository, type AbsItemPageQuery, type AbsItemSort } from '../audiobookshelf.repository';
import { ABS_DEFAULT_ITEM_LIMIT, ABS_MAX_ITEM_LIMIT, ABS_PROVIDER, ABS_METADATA_PRECEDENCE } from '../audiobookshelf.constants';
import type { AbsLibrary, AbsLibraryFilterData, AbsLibraryItemMinified, AbsPaginatedItems } from '../audiobookshelf.types';
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
      libraries: libraries.map((library) => ({
        id: toAbsUuid(library.id),
        name: library.name,
        folders: (foldersByLibraryId.get(library.id) ?? []).map((folder) => ({
          id: toAbsUuid(folder.id),
          fullPath: folder.path,
          libraryId: toAbsUuid(library.id),
          addedAt: folder.createdAt.getTime(),
        })),
        displayOrder: library.displayOrder,
        // BookOrbit's own icon picker doesn't share ABS's icon vocabulary, and this field is
        // purely cosmetic for ABS clients, so use a known-valid ABS icon name unconditionally.
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
          // Real ABS uses null here to mean "use the server default"; sending a populated value
          // (BookOrbit's own configured threshold) breaks decoding for at least one ABS client.
          // This field is cosmetic for a reading client - BookOrbit computes isFinished itself.
          markAsFinishedPercentComplete: null,
          markAsFinishedTimeRemaining: 10,
        },
        lastScan: library.updatedAt.getTime(),
        lastScanVersion: '2.36.0',
        createdAt: library.createdAt.getTime(),
        lastUpdate: library.updatedAt.getTime(),
      })),
    };
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
      sortDesc: false,
      mediaType: 'book',
      minified: false,
      collapseseries: false,
      include: '',
      offset: page * limit,
    };
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
    case 'addedAt':
    case 'updatedAt':
      return value;
    case 'title':
    default:
      return 'title';
  }
}
