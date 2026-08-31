import { Injectable, NotFoundException } from '@nestjs/common';

import { AudiobookshelfRepository } from '../audiobookshelf.repository';
import { AudiobookshelfItemsService } from './audiobookshelf-items.service';
import { AudiobookshelfLibrariesService } from './audiobookshelf-libraries.service';
import type { AbsPaginatedSeries, AbsSeries, AbsSeriesExpanded } from '../audiobookshelf.types';
import type { RequestUser } from '../../../common/types/request-user';
import { toAbsUuid } from '../../../common/utils/abs-id.utils';

@Injectable()
export class AudiobookshelfSeriesService {
  constructor(
    private readonly repository: AudiobookshelfRepository,
    private readonly itemsService: AudiobookshelfItemsService,
    private readonly librariesService: AudiobookshelfLibrariesService,
  ) {}

  /** GET /api/libraries/:id/series - series that have audio books in one library. */
  async listLibrarySeries(user: RequestUser, libraryId: number, limit = 5, page = 0, sortBy = 'name', desc = false): Promise<AbsPaginatedSeries> {
    await this.librariesService.requireExposedLibrary(user, libraryId);
    const contentFilters = user.isSuperuser ? undefined : user.contentFilters;
    const rows = await this.repository.findSeriesByLibraries([libraryId], contentFilters);
    const offset = page * limit;
    const pageRows = rows.slice(offset, offset + limit);
    return {
      results: pageRows.map((row) => this.toSeries(row, toAbsUuid(libraryId))),
      total: rows.length,
      limit,
      page,
      sortBy,
      sortDesc: desc,
      minified: false,
      include: '',
    };
  }

  /** GET /api/series/:id and GET /api/libraries/:id/series/:seriesId - series with its audio
   * items. Real ABS always includes libraryId here, even on the bare (non-library-scoped) route -
   * BookOrbit's series aren't library-scoped, so it's derived from the series' own (exposed)
   * items when the route didn't pass one explicitly. */
  async getSeries(user: RequestUser, seriesId: number, libraryId?: number): Promise<AbsSeriesExpanded> {
    const series = await this.repository.findSeriesById(seriesId);
    if (!series) throw new NotFoundException(`Series ${seriesId} not found`);

    const contentFilters = user.isSuperuser ? undefined : user.contentFilters;
    const libraryIds = libraryId !== undefined ? [libraryId] : await this.librariesService.getExposedLibraryIds(user);
    if (libraryId !== undefined) {
      await this.librariesService.requireExposedLibrary(user, libraryId);
    }
    const exposedBookIds = new Set(await this.repository.findAudioBookIdsByLibraries(libraryIds, contentFilters));

    const memberships = await this.repository.findSeriesMembershipBookIds([seriesId]);
    const bookIds = memberships
      .filter((membership) => membership.seriesId === seriesId && exposedBookIds.has(membership.bookId))
      .map((membership) => membership.bookId);
    const items = await this.itemsService.getMinifiedItemsByIds(bookIds);

    const resolvedLibraryId =
      libraryId !== undefined ? toAbsUuid(libraryId) : (items[0]?.libraryId ?? (libraryIds[0] !== undefined ? toAbsUuid(libraryIds[0]) : undefined));

    return {
      ...this.toSeries(series, resolvedLibraryId),
      items,
    };
  }

  private toSeries(series: { id: number; name: string }, libraryId?: string): AbsSeries {
    return {
      id: toAbsUuid(series.id),
      name: series.name,
      description: null,
      addedAt: 0,
      updatedAt: 0,
      ...(libraryId !== undefined ? { libraryId } : {}),
    };
  }
}
