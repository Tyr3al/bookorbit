import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseArrayPipe, Patch, Query, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../../common/types/request-user';
import { UpdateAbsProgressDto } from '../dto/update-abs-progress.dto';
import { AudiobookshelfAuthService } from '../services/audiobookshelf-auth.service';
import { AudiobookshelfProgressService } from '../services/audiobookshelf-progress.service';
import { extractBearerToken } from './authorize.controller';
import { parseAbsId } from '../pipes/abs-id.pipe';
import { AudiobookshelfEnabledGuard } from '../audiobookshelf-enabled.guard';

@Controller('api/me')
@UseGuards(AudiobookshelfEnabledGuard)
export class MeController {
  constructor(
    private readonly authService: AudiobookshelfAuthService,
    private readonly progressService: AudiobookshelfProgressService,
  ) {}

  @Get()
  me(@CurrentUser() user: RequestUser, @Req() req: FastifyRequest) {
    return this.authService.me(user, extractBearerToken(req));
  }

  @Get('listening-sessions')
  listeningSessions() {
    return { total: 0, numPages: 0, page: 0, itemsPerPage: 10, sessions: [] };
  }

  @Get('item/listening-sessions/:libraryItemId/:episodeId?')
  itemListeningSessions(@Query('page') page?: string, @Query('itemsPerPage') itemsPerPage?: string) {
    const parsedItemsPerPage = itemsPerPage ? Number(itemsPerPage) : 10;
    const parsedPage = page ? Number(page) : 0;
    return { total: 0, numPages: 0, page: parsedPage, itemsPerPage: parsedItemsPerPage, sessions: [] };
  }

  @Patch('progress/batch/update')
  @HttpCode(HttpStatus.OK)
  batchUpdateProgress(@CurrentUser() user: RequestUser, @Body(new ParseArrayPipe({ items: UpdateAbsProgressDto })) items: UpdateAbsProgressDto[]) {
    return this.progressService.batchUpdateMediaProgress(user, items);
  }

  @Get('progress')
  async getAllProgress(@CurrentUser() user: RequestUser) {
    return { mediaProgress: await this.progressService.getMediaProgressForUser(user) };
  }

  @Get('progress/:libraryItemId/:episodeId?')
  getProgress(@CurrentUser() user: RequestUser, @Param('libraryItemId') libraryItemId: string) {
    return this.progressService.getMediaProgress(user, parseAbsId(libraryItemId));
  }

  @Patch('progress/:libraryItemId/:episodeId?')
  @HttpCode(HttpStatus.OK)
  updateProgress(@CurrentUser() user: RequestUser, @Param('libraryItemId') libraryItemId: string, @Body() dto: UpdateAbsProgressDto) {
    return this.progressService.updateMediaProgress(user, parseAbsId(libraryItemId), dto);
  }
}
