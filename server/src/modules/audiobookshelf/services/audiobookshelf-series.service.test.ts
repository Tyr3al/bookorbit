import { describe, expect, it, vi } from 'vitest';

import type { RequestUser } from '../../../common/types/request-user';
import { AudiobookshelfSeriesService } from './audiobookshelf-series.service';

const user = { id: 7, isSuperuser: false, contentFilters: {} } as RequestUser;

function createService() {
  const repository = {
    findSeriesById: vi.fn(),
    findAccessibleSeriesBook: vi.fn(),
  };
  const librariesService = {
    getExposedLibraryIds: vi.fn(),
    requireExposedLibrary: vi.fn(),
  };
  const service = new AudiobookshelfSeriesService(repository as never, {} as never, librariesService as never);
  return { service, repository, librariesService };
}

describe('AudiobookshelfSeriesService', () => {
  it('rejects a globally requested series without an accessible audio book', async () => {
    const { service, repository, librariesService } = createService();
    repository.findSeriesById.mockResolvedValue({ id: 12, name: 'Hidden' });
    librariesService.getExposedLibraryIds.mockResolvedValue([3]);
    repository.findAccessibleSeriesBook.mockResolvedValue(undefined);

    await expect(service.getSeries(user, 12)).rejects.toThrow('Series 12 not found');
    expect(repository.findSeriesById).not.toHaveBeenCalled();
  });

  it('restricts a library-scoped series to books in the requested exposed library', async () => {
    const { service, repository, librariesService } = createService();
    repository.findSeriesById.mockResolvedValue({ id: 12, name: 'Mixed' });
    librariesService.requireExposedLibrary.mockResolvedValue(undefined);
    repository.findAccessibleSeriesBook.mockResolvedValue(undefined);

    await expect(service.getSeries(user, 12, 3)).rejects.toThrow('Series 12 not found');
    expect(librariesService.requireExposedLibrary).toHaveBeenCalledWith(user, 3);
    expect(repository.findAccessibleSeriesBook).toHaveBeenCalledWith(12, [3], user.contentFilters);
  });

  it('uses an accessible book to derive the global series library', async () => {
    const { service, repository, librariesService } = createService();
    repository.findSeriesById.mockResolvedValue({ id: 12, name: 'Visible' });
    librariesService.getExposedLibraryIds.mockResolvedValue([3, 4]);
    repository.findAccessibleSeriesBook.mockResolvedValue({ bookId: 42, libraryId: 4 });

    await expect(service.getSeries(user, 12)).resolves.toMatchObject({ libraryId: '00000000-0000-4000-8000-000000000004' });
    expect(repository.findAccessibleSeriesBook).toHaveBeenCalledWith(12, [3, 4], user.contentFilters);
  });
});
