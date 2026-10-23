import { Body, Controller, Get, Param, ParseIntPipe, Put } from '@nestjs/common';

import { AuditAction, AuditResource, Permission, type AudiobookshelfLibraryExposure } from '@bookorbit/types';
import { Auditable } from '../../../common/decorators/auditable.decorator';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator';
import { UpdateAudiobookshelfLibraryExposureDto } from '../dto/update-audiobookshelf-library-exposure.dto';
import { AudiobookshelfLibrarySettingsService } from '../services/audiobookshelf-library-settings.service';

/**
 * BookOrbit-side settings for the ABS integration, served at /api/v1/abs/settings/libraries.
 * Not an ABS client route, so it is gated by BookOrbit permissions rather than the ABS enabled
 * switch: an admin chooses libraries before or after turning the API on.
 */
@Controller('settings/libraries')
@RequirePermission(Permission.ManageLibraries)
export class AudiobookshelfLibrarySettingsController {
  constructor(private readonly service: AudiobookshelfLibrarySettingsService) {}

  @Get()
  list(): Promise<AudiobookshelfLibraryExposure[]> {
    return this.service.list();
  }

  @Put(':id')
  @Auditable({
    action: AuditAction.LibraryUpdate,
    resource: AuditResource.Library,
    getResourceId: (req) => parseInt(req.params['id'] as string, 10),
    description: (req) => `Changed Audiobookshelf exposure of library #${req.params['id']}`,
  })
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateAudiobookshelfLibraryExposureDto): Promise<AudiobookshelfLibraryExposure> {
    return this.service.setExposed(id, dto.exposed);
  }
}
