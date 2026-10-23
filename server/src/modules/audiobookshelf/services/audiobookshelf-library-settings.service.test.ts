import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { AudiobookshelfLibrarySettingsService } from './audiobookshelf-library-settings.service';

function makeService(library: { id: number; name: string; type: string } | undefined) {
  const repository = {
    findBookLibraryExposures: vi.fn().mockResolvedValue([{ id: 1, name: 'Audiobooks', exposed: true }]),
    findLibraryById: vi.fn().mockResolvedValue(library),
    setLibraryExposed: vi.fn().mockResolvedValue(undefined),
  };
  return { service: new AudiobookshelfLibrarySettingsService(repository as never), repository };
}

describe('AudiobookshelfLibrarySettingsService', () => {
  it('lists book libraries with their exposure', async () => {
    const { service } = makeService(undefined);

    await expect(service.list()).resolves.toEqual([{ id: 1, name: 'Audiobooks', exposed: true }]);
  });

  it('changes the exposure of a book library', async () => {
    const { service, repository } = makeService({ id: 4, name: 'Audiobooks', type: 'books' });

    await expect(service.setExposed(4, false)).resolves.toEqual({ id: 4, name: 'Audiobooks', exposed: false });
    expect(repository.setLibraryExposed).toHaveBeenCalledWith(4, false);
  });

  it.each([
    ['an unknown library', undefined],
    ['a podcast library', { id: 4, name: 'Podcasts', type: 'podcasts' }],
  ])('404s %s without writing', async (_label, library) => {
    const { service, repository } = makeService(library);

    await expect(service.setExposed(4, true)).rejects.toBeInstanceOf(NotFoundException);
    expect(repository.setLibraryExposed).not.toHaveBeenCalled();
  });
});
