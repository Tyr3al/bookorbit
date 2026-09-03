import { Controller, Get, UseGuards } from '@nestjs/common';

import { Public } from '../../../common/decorators/public.decorator';
import { AUDIOBOOKSHELF_SERVER_VERSION } from '../audiobookshelf.constants';
import { AudiobookshelfEnabledGuard } from '../audiobookshelf-enabled.guard';

/**
 * GET /status - the public endpoint ABS clients (Prologue) probe when a server address is
 * entered. It both validates that the address is an Audiobookshelf server and advertises the
 * available login methods (`authMethods`), which is where Prologue's "OIDC or credentials"
 * choice comes from. The response mirrors the real ABS payload.
 */
@Controller('status')
@Public()
@UseGuards(AudiobookshelfEnabledGuard)
export class AudiobookshelfStatusController {
  @Get()
  status() {
    return {
      app: 'audiobookshelf',
      serverVersion: AUDIOBOOKSHELF_SERVER_VERSION,
      isInit: true,
      language: 'en-us',
      authMethods: ['local'],
      authFormData: {
        authLoginCustomMessage: '',
      },
    };
  }
}
