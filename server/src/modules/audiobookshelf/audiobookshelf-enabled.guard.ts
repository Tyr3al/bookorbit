import { CanActivate, ForbiddenException, Injectable } from '@nestjs/common';

import { AppSettingsService } from '../app-settings/app-settings.service';

@Injectable()
export class AudiobookshelfEnabledGuard implements CanActivate {
  constructor(private readonly appSettingsService: AppSettingsService) {}

  async canActivate(): Promise<boolean> {
    if (!(await this.appSettingsService.isAudiobookshelfEnabled())) {
      throw new ForbiddenException('Audiobookshelf API is disabled');
    }
    return true;
  }
}
