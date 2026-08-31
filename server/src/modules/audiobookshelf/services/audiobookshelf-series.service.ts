import { Injectable, NotFoundException } from '@nestjs/common';

import { AudiobookshelfRepository } from '../audiobookshelf.repository';
import { AudiobookshelfItemsService } from './audiobookshelf-items.service';
import { AudiobookshelfLibrariesService } from './audiobookshelf-libraries.service';
import type { AbsLibraryItemMinified, AbsPaginatedSeries, AbsSeries, AbsSeriesListItem } from '../audiobookshelf.types';
import type { RequestUser } from '../../../common/types/request-user';
import { toAbsUuid, fromAbsUuid } from '../../../common/utils/abs-id.utils';

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
  async listLibrarySeries(user: RequestUser, libraryId: number, limit = 5, page = 0, sortBy = 'name', desc = false): Promise<AbsPaginatedSeries> {
    await this.librariesService.requireExposedLibrary(user, libraryId);
    const contentFilters = user.isSuperuser ? undefined : user.contentFilters;
    const rows = await this.repository.findSeriesByLibraries([libraryId], contentFilters);
    const offset = page * limit;
    const pageRows = rows.slice(offset, offset + limit);

    const exposedBookIds = new Set(await this.repository.findAudioBookIdsByLibraries([libraryId], contentFilters));
    const memberships = await this.repository.findSeriesMembershipBookIds(pageRows.map((row) => row.id));
    const bookIdsBySeriesId = new Map<number, number[]>();
    for (const membership of memberships) {
      if (!exposedBookIds.has(membership.bookId)) continue;
      const list = bookIdsBySeriesId.get(membership.seriesId);
      if (list) list.push(membership.bookId);
      else bookIdsBySeriesId.set(membership.seriesId, [membership.bookId]);
    }
    const allBookIds = [...bookIdsBySeriesId.values()].flat();
    const itemsByBookId = new Map((await this.itemsService.getMinifiedItemsByIds(allBookIds)).map((item) => [fromAbsUuid(item.id), item] as const));

    const results: AbsSeriesListItem[] = pageRows.map((row) => ({
      ...this.toSeries(row, toAbsUuid(libraryId)),
      books: (bookIdsBySeriesId.get(row.id) ?? [])
        .map((bookId) => itemsByBookId.get(bookId))
        .filter((item): item is AbsLibraryItemMinified => item != null),
    }));

    return {
      results,
      total: rows.length,
      limit,
      page,
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
  async getSeries(user: RequestUser, seriesId: number, libraryId?: number): Promise<AbsSeries> {
    const series = await this.repository.findSeriesById(seriesId);
    if (!series) throw new NotFoundException(`Series ${seriesId} not found`);

    if (libraryId !== undefined) {
      await this.librariesService.requireExposedLibrary(user, libraryId);
      return this.toSeries(series, toAbsUuid(libraryId));
    }

    return this.toSeries(series, await this.resolveSeriesLibraryId(user, seriesId));
  }

  private async resolveSeriesLibraryId(user: RequestUser, seriesId: number): Promise<string | undefined> {
    const memberships = await this.repository.findSeriesMembershipBookIds([seriesId]);
    if (memberships.length > 0) {
      const [book] = await this.repository.findBooksByIds([memberships[0].bookId]);
      if (book) return toAbsUuid(book.libraryId);
    }
    const libraryIds = await this.librariesService.getExposedLibraryIds(user);
    return libraryIds[0] !== undefined ? toAbsUuid(libraryIds[0]) : undefined;
  }

  private toSeries(series: { id: number; name: string; createdAt?: Date; updatedAt?: Date }, libraryId?: string): AbsSeries {
    return {
      id: toAbsUuid(series.id),
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
