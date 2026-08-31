import { Controller, Get, Param, Query, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';

import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../../common/types/request-user';
import { AudiobookshelfAuthorsService } from '../services/audiobookshelf-authors.service';
import { parseAbsId } from '../pipes/abs-id.pipe';
import { imageContentTypeFromPath } from '../../../common/image-content-type';
import { AudiobookshelfEnabledGuard } from '../audiobookshelf-enabled.guard';

@Controller('api/authors')
@UseGuards(AudiobookshelfEnabledGuard)
export class AuthorsController {
  constructor(private readonly authorsService: AudiobookshelfAuthorsService) {}

  @Get(':id')
  getAuthor(@CurrentUser() user: RequestUser, @Param('id') id: string, @Query('include') include?: string) {
    return this.authorsService.getAuthor(user, parseAbsId(id), include);
  }

  @Get(':id/image')
  async image(@CurrentUser() user: RequestUser, @Param('id') id: string, @Res() reply: FastifyReply) {
    const imagePath = await this.authorsService.getImagePath(user, parseAbsId(id));
    if (!imagePath) {
      reply.status(404).send();
      return;
    }
    const { mtimeMs } = await stat(imagePath);
    reply.header('Cache-Control', 'private, max-age=86400');
    reply.header('ETag', `"${Math.floor(mtimeMs)}"`);
    reply.type(imageContentTypeFromPath(imagePath));
    reply.send(createReadStream(imagePath));
  }
}
