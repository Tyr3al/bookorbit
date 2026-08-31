import { describe, expect, it, vi } from 'vitest';

import type { RequestUser } from '../../../common/types/request-user';
import { AudiobookshelfSeriesService } from './audiobookshelf-series.service';

const user = { id: 7, isSuperuser: false, contentFilters: {} } as RequestUser;

function createService() {
  const repository = {
    findSeriesById: vi.fn(),
    findAccessibleSeriesBook: vi.fn(),
    findSeriesByLibraries: vi.fn(),
    findSeriesByLibrariesPage: vi.fn(),
    findSeriesMembershipBookIdsByLibraries: vi.fn(),
  };
  const itemsService = { getMinifiedItemsByIds: vi.fn().mockResolvedValue([]) };
  const librariesService = {
    getExposedLibraryIds: vi.fn(),
    requireExposedLibrary: vi.fn(),
  };
  const service = new AudiobookshelfSeriesService(repository as never, itemsService as never, librariesService as never);
  return { service, repository, itemsService, librariesService };
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

  it('pages and sorts series through the scoped repository query', async () => {
    const { service, repository, itemsService, librariesService } = createService();
    librariesService.requireExposedLibrary.mockResolvedValue(undefined);
    repository.findSeriesByLibrariesPage.mockResolvedValue({
      rows: [{ id: 12, name: 'Series', createdAt: new Date(1), updatedAt: new Date(2) }],
      total: 101,
    });
    repository.findSeriesMembershipBookIdsByLibraries.mockResolvedValue([{ seriesId: 12, bookId: 42 }]);
    itemsService.getMinifiedItemsByIds.mockResolvedValue([{ id: '00000000-0000-4000-8000-00000000002a' }]);

    await expect(service.listLibrarySeries(user, 3, 200.9, -2, 'numBooks', true)).resolves.toMatchObject({
      total: 101,
      limit: 100,
      page: 0,
      sortBy: 'numBooks',
      sortDesc: true,
      results: [{ id: expect.any(String), books: [{ id: expect.any(String) }] }],
    });
    expect(repository.findSeriesByLibrariesPage).toHaveBeenCalledWith([3], user.contentFilters, 100, 0, 'numBooks', true);
    expect(repository.findSeriesMembershipBookIdsByLibraries).toHaveBeenCalledWith([12], [3], user.contentFilters);
    expect(repository.findSeriesByLibraries).not.toHaveBeenCalled();
  });
});
