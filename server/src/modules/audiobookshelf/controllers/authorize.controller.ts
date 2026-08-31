import { Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../../common/types/request-user';
import { AudiobookshelfAuthService } from '../services/audiobookshelf-auth.service';
import { AudiobookshelfEnabledGuard } from '../audiobookshelf-enabled.guard';

@Controller('api/authorize')
@UseGuards(AudiobookshelfEnabledGuard)
export class AuthorizeController {
  constructor(private readonly authService: AudiobookshelfAuthService) {}

  @Get()
  authorize(@CurrentUser() user: RequestUser, @Req() req: FastifyRequest) {
    return this.authorizeRequest(user, req);
  }

  @Post()
  authorizePost(@CurrentUser() user: RequestUser, @Req() req: FastifyRequest) {
    return this.authorizeRequest(user, req);
  }

  private authorizeRequest(user: RequestUser, req: FastifyRequest) {
    return this.authService.authorize(user, extractBearerToken(req));
  }
}

export function extractBearerToken(req: FastifyRequest): string | undefined {
  const header = req.headers.authorization;
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1] ?? undefined;
}
