import { Controller, Get, Param, UseGuards } from '@nestjs/common';

import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../../common/types/request-user';
import { AudiobookshelfSeriesService } from '../services/audiobookshelf-series.service';
import { parseAbsId } from '../pipes/abs-id.pipe';
import { AudiobookshelfEnabledGuard } from '../audiobookshelf-enabled.guard';

@Controller('api/series')
@UseGuards(AudiobookshelfEnabledGuard)
export class SeriesController {
  constructor(private readonly seriesService: AudiobookshelfSeriesService) {}

  @Get(':id')
  getSeries(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.seriesService.getSeries(user, parseAbsId(id));
  }
}
