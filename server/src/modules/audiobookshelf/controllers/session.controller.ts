import { Body, Controller, Header, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';

import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../../common/types/request-user';
import { AudiobookshelfProgressService } from '../services/audiobookshelf-progress.service';
import { AudiobookshelfPlaybackService } from '../services/audiobookshelf-playback.service';
import { AudiobookshelfEnabledGuard } from '../audiobookshelf-enabled.guard';

@Controller('api/session')
@UseGuards(AudiobookshelfEnabledGuard)
export class SessionController {
  constructor(
    private readonly progressService: AudiobookshelfProgressService,
    private readonly playbackService: AudiobookshelfPlaybackService,
  ) {}

  @Post('local-all')
  @HttpCode(HttpStatus.OK)
  syncLocalSessions(@CurrentUser() user: RequestUser, @Body() body: unknown) {
    const sessions = Array.isArray(body) ? body : [];
    return this.progressService.syncLocalSessions(user, sessions);
  }

  @Post(':id/sync')
  @HttpCode(HttpStatus.OK)
  @Header('Content-Type', 'text/plain')
  async syncSession(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body() body: unknown): Promise<string> {
    await this.playbackService.sync(user, id, body);
    return 'OK';
  }

  @Post(':id/close')
  @HttpCode(HttpStatus.OK)
  @Header('Content-Type', 'text/plain')
  async closeSession(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body() body: unknown): Promise<string> {
    await this.playbackService.close(user, id, body);
    return 'OK';
  }
}
