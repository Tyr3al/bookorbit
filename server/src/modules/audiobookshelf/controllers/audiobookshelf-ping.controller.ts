import { Controller, Get, UseGuards } from '@nestjs/common';

import { Public } from '../../../common/decorators/public.decorator';
import { AudiobookshelfEnabledGuard } from '../audiobookshelf-enabled.guard';

/** GET /ping - health probe used by ABS clients (Prologue calls it during library sync). */
@Controller('ping')
@Public()
@UseGuards(AudiobookshelfEnabledGuard)
export class AudiobookshelfPingController {
  @Get()
  ping() {
    return { success: true };
  }
}
