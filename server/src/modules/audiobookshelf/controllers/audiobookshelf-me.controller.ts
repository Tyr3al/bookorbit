import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseArrayPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../../common/types/request-user';
import { UpdateAudiobookshelfProgressDto } from '../dto/update-audiobookshelf-progress.dto';
import { AUDIOBOOKSHELF_DEFAULT_SESSIONS_PAGE_SIZE } from '../audiobookshelf.constants';
import { AudiobookshelfAuthService } from '../services/audiobookshelf-auth.service';
import { AudiobookshelfProgressService } from '../services/audiobookshelf-progress.service';
import { AudiobookshelfBookmarksService } from '../services/audiobookshelf-bookmarks.service';
import { AudiobookshelfSessionsService } from '../services/audiobookshelf-sessions.service';
import { CreateAudiobookshelfBookmarkDto, UpdateAudiobookshelfBookmarkDto } from '../dto/audiobookshelf-bookmark.dto';
import { extractBearerToken } from './audiobookshelf-authorize.controller';
import { parseAudiobookshelfId } from '../pipes/audiobookshelf-id.pipe';
import { AudiobookshelfEnabledGuard } from '../audiobookshelf-enabled.guard';

@Controller('api/me')
@UseGuards(AudiobookshelfEnabledGuard)
export class AudiobookshelfMeController {
  constructor(
    private readonly authService: AudiobookshelfAuthService,
    private readonly progressService: AudiobookshelfProgressService,
    private readonly bookmarksService: AudiobookshelfBookmarksService,
    private readonly sessionsService: AudiobookshelfSessionsService,
  ) {}

  @Get()
  me(@CurrentUser() user: RequestUser, @Req() req: FastifyRequest) {
    return this.authService.me(user, extractBearerToken(req));
  }

  @Get('listening-sessions')
  listeningSessions(@CurrentUser() user: RequestUser, @Query('page') page?: string, @Query('itemsPerPage') itemsPerPage?: string) {
    return this.sessionsService.getSessionsPage(
      user,
      parseOptionalInt(page) ?? 0,
      parseOptionalInt(itemsPerPage) ?? AUDIOBOOKSHELF_DEFAULT_SESSIONS_PAGE_SIZE,
    );
  }

  @Get('listening-stats')
  listeningStats(@CurrentUser() user: RequestUser) {
    return this.sessionsService.getListeningStats(user);
  }

  @Get('item/listening-sessions/:libraryItemId/:episodeId?')
  itemListeningSessions(
    @CurrentUser() user: RequestUser,
    @Param('libraryItemId') libraryItemId: string,
    @Query('page') page?: string,
    @Query('itemsPerPage') itemsPerPage?: string,
  ) {
    return this.sessionsService.getItemSessionsPage(
      user,
      parseAudiobookshelfId(libraryItemId),
      parseOptionalInt(page) ?? 0,
      parseOptionalInt(itemsPerPage) ?? AUDIOBOOKSHELF_DEFAULT_SESSIONS_PAGE_SIZE,
    );
  }

  @Patch('progress/batch/update')
  @HttpCode(HttpStatus.OK)
  batchUpdateProgress(
    @CurrentUser() user: RequestUser,
    @Body(new ParseArrayPipe({ items: UpdateAudiobookshelfProgressDto })) items: UpdateAudiobookshelfProgressDto[],
  ) {
    return this.progressService.batchUpdateMediaProgress(user, items);
  }

  @Get('progress')
  async getAllProgress(@CurrentUser() user: RequestUser) {
    return { mediaProgress: await this.progressService.getMediaProgressForUser(user) };
  }

  @Get('items-in-progress')
  getItemsInProgress(@CurrentUser() user: RequestUser, @Query('limit') limit?: string) {
    return this.progressService.getItemsInProgress(user, parseOptionalInt(limit));
  }

  @Get('bookmarks')
  getBookmarks(@CurrentUser() user: RequestUser) {
    return this.bookmarksService.getBookmarks(user);
  }

  @Get('bookmarks/:libraryItemId')
  getItemBookmarks(@CurrentUser() user: RequestUser, @Param('libraryItemId') libraryItemId: string) {
    return this.bookmarksService.getBookmarksForItem(user, parseAudiobookshelfId(libraryItemId));
  }

  @Post('item/:libraryItemId/bookmark')
  createBookmark(@CurrentUser() user: RequestUser, @Param('libraryItemId') libraryItemId: string, @Body() dto: CreateAudiobookshelfBookmarkDto) {
    return this.bookmarksService.createBookmark(user, parseAudiobookshelfId(libraryItemId), dto.time, dto.title);
  }

  @Patch('item/:libraryItemId/bookmark')
  updateBookmark(@CurrentUser() user: RequestUser, @Param('libraryItemId') libraryItemId: string, @Body() dto: UpdateAudiobookshelfBookmarkDto) {
    return this.bookmarksService.updateBookmark(user, parseAudiobookshelfId(libraryItemId), dto.time, dto.title);
  }

  @Delete('item/:libraryItemId/bookmark/:time')
  @HttpCode(HttpStatus.OK)
  @Header('Content-Type', 'text/plain')
  async deleteBookmark(@CurrentUser() user: RequestUser, @Param('libraryItemId') libraryItemId: string, @Param('time') time: string) {
    await this.bookmarksService.deleteBookmark(user, parseAudiobookshelfId(libraryItemId), parseBookmarkTime(time));
    return 'OK';
  }

  @Get('progress/:libraryItemId/:episodeId?')
  getProgress(@CurrentUser() user: RequestUser, @Param('libraryItemId') libraryItemId: string) {
    return this.progressService.getMediaProgress(user, parseAudiobookshelfId(libraryItemId));
  }

  @Patch('progress/:libraryItemId/:episodeId?')
  @HttpCode(HttpStatus.OK)
  updateProgress(@CurrentUser() user: RequestUser, @Param('libraryItemId') libraryItemId: string, @Body() dto: UpdateAudiobookshelfProgressDto) {
    return this.progressService.updateMediaProgress(user, parseAudiobookshelfId(libraryItemId), dto);
  }

  @Delete('progress/:id')
  @HttpCode(HttpStatus.OK)
  @Header('Content-Type', 'text/plain')
  async deleteProgress(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    await this.progressService.deleteMediaProgress(user, id);
    return 'OK';
  }
}

function parseOptionalInt(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseBookmarkTime(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new BadRequestException('Invalid bookmark time');
  return parsed;
}
