import { BadRequestException, Controller, Get, Headers, NotFoundException, Param, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import { Public } from '../../../common/decorators/public.decorator';
import { AudiobookshelfEnabledGuard } from '../audiobookshelf-enabled.guard';
import { AbsOpenSessionStore } from '../services/abs-open-session.store';
import { AudiobookshelfStreamService } from '../services/audiobookshelf-stream.service';

/**
 * Public (unauthenticated) ABS media routes, mirroring upstream's PublicRouter. AudioBooth and
 * similar clients stream each track from `{server}/public/session/:id/track/:index` with no auth
 * headers - the session id is the bearer secret. The session must be an *open* playback session
 * (see AbsOpenSessionStore); unknown or closed sessions 404 like upstream.
 */
@Controller('public/session')
@Public()
@UseGuards(AudiobookshelfEnabledGuard)
export class PublicSessionController {
  constructor(
    private readonly openSessions: AbsOpenSessionStore,
    private readonly streamService: AudiobookshelfStreamService,
  ) {}

  @Get(':id/track/:index')
  track(@Param('id') id: string, @Param('index') index: string, @Res() reply: FastifyReply, @Headers('range') range?: string) {
    const session = this.openSessions.get(id);
    if (!session) throw new NotFoundException('Session not found');
    return this.streamService.streamSessionTrack(session, parseTrackIndex(index), reply, range);
  }
}

function parseTrackIndex(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new BadRequestException('Invalid track index');
  return parsed;
}
