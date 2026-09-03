import { Controller, Get, Param, UseGuards } from '@nestjs/common';

import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../../common/types/request-user';
import { AudiobookshelfCollectionsService } from '../services/audiobookshelf-collections.service';
import { parseAudiobookshelfId } from '../pipes/audiobookshelf-id.pipe';
import { AudiobookshelfEnabledGuard } from '../audiobookshelf-enabled.guard';

@Controller('api/collections')
@UseGuards(AudiobookshelfEnabledGuard)
export class AudiobookshelfCollectionsController {
  constructor(private readonly collectionsService: AudiobookshelfCollectionsService) {}

  @Get()
  list(@CurrentUser() user: RequestUser) {
    return this.collectionsService.listCollections(user);
  }

  @Get(':id')
  get(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.collectionsService.getCollection(user, parseAudiobookshelfId(id));
  }
}
