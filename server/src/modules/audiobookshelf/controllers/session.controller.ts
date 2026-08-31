import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';

import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../../common/types/request-user';
import { AudiobookshelfProgressService } from '../services/audiobookshelf-progress.service';
import { AudiobookshelfEnabledGuard } from '../audiobookshelf-enabled.guard';

@Controller('api/session')
@UseGuards(AudiobookshelfEnabledGuard)
export class SessionController {
  constructor(private readonly progressService: AudiobookshelfProgressService) {}

  @Post('local-all')
  @HttpCode(HttpStatus.OK)
  syncLocalSessions(@CurrentUser() user: RequestUser, @Body() body: unknown) {
    const sessions = Array.isArray(body) ? body : [];
    return this.progressService.syncLocalSessions(user, sessions);
  }
}
