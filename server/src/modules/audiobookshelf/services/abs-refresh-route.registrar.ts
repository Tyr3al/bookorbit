import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { FastifyInstance, FastifyReply } from 'fastify';

import { AudiobookshelfAuthService } from './audiobookshelf-auth.service';
import { ABS_BASE_PATH } from '../audiobookshelf.constants';
import { AppSettingsService } from '../../app-settings/app-settings.service';

/**
 * Registers the ABS-compatible `POST /abs/auth/refresh` route directly on Fastify. This used to
 * collide with the web app's own `auth/refresh` route (both needed the literal Nest path
 * `auth/refresh` before the `/abs` prefix existed), so it couldn't be a normal controller route;
 * left as a raw route since it still works and needs no DTO/pipe machinery. Prologue calls this
 * endpoint with the `x-refresh-token` header to rotate its token pair.
 */
@Injectable()
export class AbsRefreshRouteRegistrar implements OnApplicationBootstrap {
  constructor(
    private readonly authService: AudiobookshelfAuthService,
    private readonly appSettingsService: AppSettingsService,
    private readonly httpAdapterHost: HttpAdapterHost,
  ) {}

  onApplicationBootstrap() {
    const fastify = this.httpAdapterHost.httpAdapter.getInstance() as FastifyInstance;
    fastify.post(`${ABS_BASE_PATH}/auth/refresh`, async (request, reply) => {
      // Bypasses Nest's guard pipeline (it's a raw route, not a controller), so the master
      // enable/disable switch is enforced here explicitly instead.
      if (!(await this.appSettingsService.isAudiobookshelfEnabled())) {
        return reply.status(403).send({ statusCode: 403, message: 'Audiobookshelf API is disabled' });
      }
      const header = request.headers['x-refresh-token'];
      // The handler reply is typed by fastify/types/reply while the service expects the
      // fastify/fastify export; they are structurally identical.
      return this.authService.refresh(typeof header === 'string' ? header : undefined, reply as unknown as FastifyReply);
    });
  }
}
