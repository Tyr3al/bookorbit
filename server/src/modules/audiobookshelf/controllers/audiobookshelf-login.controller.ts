import { Body, Controller, Headers, HttpCode, HttpStatus, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { Public } from '../../../common/decorators/public.decorator';
import { LoginDto } from '../../auth/dto/login.dto';
import { AudiobookshelfAuthService } from '../services/audiobookshelf-auth.service';
import { AudiobookshelfEnabledGuard } from '../audiobookshelf-enabled.guard';
import { AUDIOBOOKSHELF_LOGIN_THROTTLE_LIMIT, AUDIOBOOKSHELF_LOGIN_THROTTLE_TTL_MS } from '../audiobookshelf.constants';

@Controller('login')
@Public()
@UseGuards(AudiobookshelfEnabledGuard)
export class AudiobookshelfLoginController {
  constructor(private readonly authService: AudiobookshelfAuthService) {}

  @Post()
  @Throttle({ default: { limit: AUDIOBOOKSHELF_LOGIN_THROTTLE_LIMIT, ttl: AUDIOBOOKSHELF_LOGIN_THROTTLE_TTL_MS } })
  @HttpCode(HttpStatus.OK)
  login(
    @Body() dto: LoginDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Headers('x-abs-client') absClient?: string,
  ) {
    return this.authService.login(dto, reply, req.ip, absClient);
  }
}
