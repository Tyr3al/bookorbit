import { BadRequestException, Controller, Get, Param, Query, UseGuards } from '@nestjs/common';

import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../../common/types/request-user';
import { AudiobookshelfLibrariesService } from '../services/audiobookshelf-libraries.service';
import { AudiobookshelfAuthorsService } from '../services/audiobookshelf-authors.service';
import { AudiobookshelfSeriesService } from '../services/audiobookshelf-series.service';
import { AudiobookshelfCollectionsService } from '../services/audiobookshelf-collections.service';
import { AudiobookshelfNarratorsService } from '../services/audiobookshelf-narrators.service';
import { parseAudiobookshelfId, parseAudiobookshelfSeriesId } from '../pipes/audiobookshelf-id.pipe';
import { AudiobookshelfEnabledGuard } from '../audiobookshelf-enabled.guard';
import type { AudiobookshelfSeriesSort } from '../audiobookshelf.types';

@Controller('api/libraries')
@UseGuards(AudiobookshelfEnabledGuard)
export class AudiobookshelfLibrariesController {
  constructor(
    private readonly librariesService: AudiobookshelfLibrariesService,
    private readonly authorsService: AudiobookshelfAuthorsService,
    private readonly seriesService: AudiobookshelfSeriesService,
    private readonly collectionsService: AudiobookshelfCollectionsService,
    private readonly narratorsService: AudiobookshelfNarratorsService,
  ) {}

  @Get()
  list(@CurrentUser() user: RequestUser) {
    return this.librariesService.findLibraries(user);
  }

  @Get(':id')
  detail(@CurrentUser() user: RequestUser, @Param('id') idParam: string, @Query('include') include?: string) {
    return this.librariesService.getLibrary(user, parseAudiobookshelfId(idParam), include);
  }

  @Get(':id/items')
  items(
    @CurrentUser() user: RequestUser,
    @Param('id') idParam: string,
    @Query('limit') limit?: string,
    @Query('page') page?: string,
    @Query('sort') sort?: string,
    @Query('desc') desc?: string,
    @Query('search') search?: string,
    @Query('filter') filter?: string,
    @Query('include') include?: string,
    @Query('minified') minified?: string,
    @Query('collapseseries') collapseseries?: string,
  ) {
    return this.librariesService.getItemsPage(user, parseAudiobookshelfId(idParam), {
      limit: parseOptionalInt(limit),
      page: parseOptionalInt(page),
      sort,
      desc,
      search,
      filter,
      include,
      minified,
      collapseseries,
    });
  }

  @Get(':id/personalized')
  personalized(@CurrentUser() user: RequestUser, @Param('id') idParam: string, @Query('limit') limit?: string) {
    return this.librariesService.getPersonalized(user, parseAudiobookshelfId(idParam), parseOptionalInt(limit));
  }

  @Get(':id/authors')
  authors(
    @CurrentUser() user: RequestUser,
    @Param('id') idParam: string,
    @Query('limit') limit?: string,
    @Query('page') page?: string,
    @Query('sort') sort?: string,
    @Query('desc') desc?: string,
    @Query('filter') filter?: string,
    @Query('minified') minified?: string,
    @Query('include') include?: string,
  ) {
    const authorSort = sort === 'numBooks' || sort === 'lastFirst' ? sort : 'name';
    return this.authorsService.listLibraryAuthors(
      user,
      parseAudiobookshelfId(idParam),
      parseOptionalInt(limit),
      parseOptionalInt(page),
      authorSort,
      desc === '1' || desc === 'true',
      filter,
      minified === '1' || minified === 'true',
      include,
    );
  }

  @Get(':id/authors/:authorId')
  authorDetail(
    @CurrentUser() user: RequestUser,
    @Param('id') idParam: string,
    @Param('authorId') authorIdParam: string,
    @Query('include') include?: string,
  ) {
    return this.authorsService.getAuthor(user, parseAudiobookshelfId(authorIdParam), include, parseAudiobookshelfId(idParam));
  }

  @Get(':id/series')
  series(
    @CurrentUser() user: RequestUser,
    @Param('id') idParam: string,
    @Query('limit') limit?: string,
    @Query('page') page?: string,
    @Query('sort') sort?: string,
    @Query('desc') desc?: string,
  ) {
    return this.seriesService.listLibrarySeries(
      user,
      parseAudiobookshelfId(idParam),
      parseOptionalInt(limit) ?? 5,
      parseOptionalInt(page) ?? 0,
      parseSeriesSort(sort),
      desc === '1' || desc === 'true',
    );
  }

  @Get(':id/series/:seriesId')
  seriesDetail(@CurrentUser() user: RequestUser, @Param('id') idParam: string, @Param('seriesId') seriesIdParam: string) {
    return this.seriesService.getSeries(user, parseAudiobookshelfSeriesId(seriesIdParam), parseAudiobookshelfId(idParam));
  }

  @Get(':id/search')
  search(@CurrentUser() user: RequestUser, @Param('id') idParam: string, @Query('q') q?: string, @Query('limit') limit?: string) {
    if (typeof q !== 'string' || q.trim().length === 0) {
      throw new BadRequestException('Invalid request. Query param "q" must be a string');
    }
    return this.librariesService.searchLibrary(user, parseAudiobookshelfId(idParam), q.trim(), parseOptionalInt(limit) ?? 12);
  }

  @Get(':id/collections')
  collections(@CurrentUser() user: RequestUser, @Param('id') idParam: string, @Query('limit') limit?: string, @Query('page') page?: string) {
    return this.collectionsService.listLibraryCollections(
      user,
      parseAudiobookshelfId(idParam),
      parseOptionalInt(limit) ?? 5,
      parseOptionalInt(page) ?? 0,
    );
  }

  @Get(':id/narrators')
  narrators(@CurrentUser() user: RequestUser, @Param('id') idParam: string) {
    return this.narratorsService.listLibraryNarrators(user, parseAudiobookshelfId(idParam));
  }

  @Get(':id/filterdata')
  filterData(@CurrentUser() user: RequestUser, @Param('id') idParam: string) {
    return this.librariesService.getFilterData(user, parseAudiobookshelfId(idParam));
  }
}

function parseOptionalInt(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseSeriesSort(value: string | undefined): AudiobookshelfSeriesSort {
  switch (value) {
    case 'addedAt':
    case 'updatedAt':
    case 'numBooks':
    case 'lastBookUpdated':
      return value;
    default:
      return 'name';
  }
}
