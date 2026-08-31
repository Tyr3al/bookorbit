import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';

import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../../common/types/request-user';
import { AudiobookshelfItemsService } from '../services/audiobookshelf-items.service';
import { AudiobookshelfStreamService } from '../services/audiobookshelf-stream.service';
import { AudiobookshelfProgressService } from '../services/audiobookshelf-progress.service';
import { parseAbsId } from '../pipes/abs-id.pipe';
import { AudiobookshelfEnabledGuard } from '../audiobookshelf-enabled.guard';
import { AudiobookshelfPlaybackService } from '../services/audiobookshelf-playback.service';
import { GetAbsItemsBatchDto } from '../dto/get-abs-items-batch.dto';

@Controller('api/items')
@UseGuards(AudiobookshelfEnabledGuard)
export class ItemsController {
  constructor(
    private readonly itemsService: AudiobookshelfItemsService,
    private readonly streamService: AudiobookshelfStreamService,
    private readonly progressService: AudiobookshelfProgressService,
    private readonly playbackService: AudiobookshelfPlaybackService,
  ) {}

  @Post('batch/get')
  @HttpCode(HttpStatus.OK)
  async getBatch(@CurrentUser() user: RequestUser, @Body() dto: GetAbsItemsBatchDto) {
    return { libraryItems: await this.itemsService.getBatchItems(user, dto.libraryItemIds) };
  }

  @Get(':id')
  async getItem(@CurrentUser() user: RequestUser, @Param('id') id: string, @Query('include') include?: string) {
    const bookId = parseAbsId(id);
    const item = await this.itemsService.getItem(user, bookId);
    if (!include?.split(',').includes('progress')) return item;
    return { ...item, userMediaProgress: await this.progressService.getMediaProgress(user, bookId) };
  }

  @Post(':id/play')
  @HttpCode(HttpStatus.OK)
  play(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body() body: unknown) {
    return this.playbackService.play(user, parseAbsId(id), body);
  }

  @Get(':id/cover')
  async cover(@CurrentUser() user: RequestUser, @Param('id') idParam: string, @Res() reply: FastifyReply) {
    const id = parseAbsId(idParam);
    const coverPath = await this.itemsService.getCoverPath(user, id);
    if (!coverPath) {
      reply.status(404).send();
      return;
    }
    const { mtimeMs } = await stat(coverPath);
    const contentType = coverPath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
    reply.header('Cache-Control', 'private, max-age=86400');
    reply.header('ETag', `"${Math.floor(mtimeMs)}"`);
    reply.type(contentType);
    reply.send(createReadStream(coverPath));
  }

  @Get(':id/download')
  download(@CurrentUser() user: RequestUser, @Param('id') id: string, @Res() reply: FastifyReply, @Headers('range') range?: string) {
    return this.streamService.download(user, parseAbsId(id), reply, range);
  }

  @Get(':id/file/:fileId')
  file(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Param('fileId') fileId: string,
    @Res() reply: FastifyReply,
    @Headers('range') range?: string,
  ) {
    return this.streamService.streamFile(user, parseAbsId(id), parseAbsId(fileId), reply, range);
  }
}
