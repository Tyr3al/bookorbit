import { Injectable, Logger, NotFoundException } from '@nestjs/common';

import type { AudiobookshelfLibraryExposure } from '@bookorbit/types';
import { AudiobookshelfRepository } from '../audiobookshelf.repository';

@Injectable()
export class AudiobookshelfLibrarySettingsService {
  private readonly logger = new Logger(AudiobookshelfLibrarySettingsService.name);

  constructor(private readonly repository: AudiobookshelfRepository) {}

  /** Book libraries only: podcast libraries have no audiobooks to expose. */
  list(): Promise<AudiobookshelfLibraryExposure[]> {
    return this.repository.findBookLibraryExposures();
  }

  async setExposed(libraryId: number, exposed: boolean): Promise<AudiobookshelfLibraryExposure> {
    const library = await this.repository.findLibraryById(libraryId);
    if (!library || library.type !== 'books') throw new NotFoundException('Library not found');
    await this.repository.setLibraryExposed(libraryId, exposed);
    this.logger.log(`[audiobookshelf.library_exposure] [end] libraryId=${libraryId} exposed=${exposed} - library exposure updated`);
    return { id: library.id, name: library.name, exposed };
  }
}
