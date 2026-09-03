import { Injectable, NotFoundException } from '@nestjs/common';

import { AudiobookshelfRepository } from '../audiobookshelf.repository';
import { AudiobookshelfItemsService } from './audiobookshelf-items.service';
import { AudiobookshelfLibrariesService } from './audiobookshelf-libraries.service';
import { AUDIOBOOKSHELF_MAX_ITEM_LIMIT } from '../audiobookshelf.constants';
import type {
  AudiobookshelfLibraryItemMinified,
  AudiobookshelfPaginatedSeries,
  AudiobookshelfSeries,
  AudiobookshelfSeriesListItem,
  AudiobookshelfSeriesSort,
} from '../audiobookshelf.types';
import type { RequestUser } from '../../../common/types/request-user';
import { toAudiobookshelfSeriesUuid, toAudiobookshelfUuid, fromAudiobookshelfUuid } from '../../../common/utils/audiobookshelf-id.utils';

@Injectable()
export class AudiobookshelfSeriesService {
  constructor(
    private readonly repository: AudiobookshelfRepository,
    private readonly itemsService: AudiobookshelfItemsService,
    private readonly librariesService: AudiobookshelfLibrariesService,
  ) {}

  /** GET /api/libraries/:id/series - series that have audio books in one library. Real ABS
   * embeds each series' minified books directly in this list (not on the single-series detail
   * fetch below), so every row here carries its own `books`. */
  async listLibrarySeries(
    user: RequestUser,
    libraryId: number,
    limit = 5,
    page = 0,
    sortBy: AudiobookshelfSeriesSort = 'name',
    desc = false,
  ): Promise<AudiobookshelfPaginatedSeries> {
    await this.librariesService.requireExposedLibrary(user, libraryId);
    const contentFilters = user.isSuperuser ? undefined : user.contentFilters;
    const effectiveLimit = clampLimit(limit);
    const effectivePage = clampPage(page);
    const offset = effectivePage * effectiveLimit;
    const pageResult = await this.repository.findSeriesByLibrariesPage([libraryId], contentFilters, effectiveLimit, offset, sortBy, desc);

    const memberships = await this.repository.findSeriesMembershipBookIdsByLibraries(
      pageResult.rows.map((row) => row.id),
      [libraryId],
      contentFilters,
    );
    const bookIdsBySeriesId = new Map<number, number[]>();
    for (const membership of memberships) {
      const list = bookIdsBySeriesId.get(membership.seriesId);
      if (list) list.push(membership.bookId);
      else bookIdsBySeriesId.set(membership.seriesId, [membership.bookId]);
    }
    const allBookIds = [...bookIdsBySeriesId.values()].flat();
    const itemsByBookId = new Map(
      (await this.itemsService.getMinifiedItemsByIds(allBookIds)).map((item) => [fromAudiobookshelfUuid(item.id), item] as const),
    );

    const results: AudiobookshelfSeriesListItem[] = pageResult.rows.map((row) => ({
      ...this.toSeries(row, toAudiobookshelfUuid(libraryId)),
      books: (bookIdsBySeriesId.get(row.id) ?? [])
        .map((bookId) => itemsByBookId.get(bookId))
        .filter((item): item is AudiobookshelfLibraryItemMinified => item != null),
    }));

    return {
      results,
      total: pageResult.total,
      limit: effectiveLimit,
      page: effectivePage,
      sortBy,
      sortDesc: desc,
      minified: false,
      include: '',
    };
  }

  /** GET /api/series/:id and GET /api/libraries/:id/series/:seriesId - series metadata only.
   * Real ABS never embeds books here, even with `include=items` - only the library-scoped list
   * above does. libraryId is always present on real ABS; BookOrbit's series aren't
   * library-scoped, so on the bare (non-library-scoped) route it's derived from one of the
   * series' own books, falling back to the user's first exposed library. */
  async getSeries(user: RequestUser, seriesId: number, libraryId?: number): Promise<AudiobookshelfSeries> {
    const contentFilters = user.isSuperuser ? undefined : user.contentFilters;
    if (libraryId !== undefined) {
      await this.librariesService.requireExposedLibrary(user, libraryId);
    }
    const exposedLibraryIds = libraryId !== undefined ? [libraryId] : await this.librariesService.getExposedLibraryIds(user);
    const accessibleBook = await this.repository.findAccessibleSeriesBook(seriesId, exposedLibraryIds, contentFilters);
    if (!accessibleBook) throw new NotFoundException(`Series ${seriesId} not found`);

    const series = await this.repository.findSeriesById(seriesId);
    if (!series) throw new NotFoundException(`Series ${seriesId} not found`);

    if (libraryId !== undefined) return this.toSeries(series, toAudiobookshelfUuid(libraryId));

    return this.toSeries(series, toAudiobookshelfUuid(accessibleBook.libraryId));
  }

  private toSeries(series: { id: number; name: string; createdAt?: Date; updatedAt?: Date }, libraryId?: string): AudiobookshelfSeries {
    return {
      id: toAudiobookshelfSeriesUuid(series.id),
      name: series.name,
      nameIgnorePrefix: series.name,
      description: null,
      // ABS clients (Prologue) do incremental sync keyed on updatedAt - a hardcoded 0 (epoch
      // 1970) reads as "older than my last sync cursor" and gets silently dropped before ever
      // reaching local storage, even though the raw list/detail response is otherwise correct.
      addedAt: series.createdAt?.getTime() ?? 0,
      updatedAt: series.updatedAt?.getTime() ?? 0,
      ...(libraryId !== undefined ? { libraryId } : {}),
    };
  }
}

function clampLimit(value: number): number {
  if (!Number.isFinite(value) || value < 1) return 5;
  return Math.min(Math.floor(value), AUDIOBOOKSHELF_MAX_ITEM_LIMIT);
}

function clampPage(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}
