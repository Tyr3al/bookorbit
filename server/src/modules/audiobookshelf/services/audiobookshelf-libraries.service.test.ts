import { describe, expect, it, vi } from 'vitest';

import type { RequestUser } from '../../../common/types/request-user';
import { toAbsUuid } from '../../../common/utils/abs-id.utils';
import { AudiobookshelfLibrariesService } from './audiobookshelf-libraries.service';

const user = { id: 7, isSuperuser: false, contentFilters: {} } as RequestUser;

const library = {
  id: 3,
  name: 'Audiobooks',
  displayOrder: 1,
  watch: true,
  autoScanCronExpression: null,
  updatedAt: new Date(2000),
  createdAt: new Date(1000),
};

function createService() {
  const repository = {
    isLibraryExposedForUser: vi.fn().mockResolvedValue(true),
    findLibraryById: vi.fn().mockResolvedValue(library),
    findFoldersByLibraryIds: vi.fn().mockResolvedValue([]),
    countAudioBooks: vi.fn().mockResolvedValue(2),
    countItemsInProgressForAudiobookshelfUser: vi.fn().mockResolvedValue(0),
    findAudioBookIds: vi.fn().mockResolvedValue([1, 2]),
    findItemsInProgressForAudiobookshelfUser: vi.fn().mockResolvedValue([]),
  };
  const itemsService = { getMinifiedItemsByIds: vi.fn().mockResolvedValue([]) };
  return { service: new AudiobookshelfLibrariesService(repository as never, itemsService as never), repository, itemsService };
}

describe('AudiobookshelfLibrariesService item pages', () => {
  it('preserves sort direction and ABS pagination metadata', async () => {
    const { service, repository } = createService();

    const result = await service.getItemsPage(user, 3, {
      limit: 10,
      page: 2,
      sort: 'updatedAt',
      desc: 'true',
      filter: 'series.foo',
      include: 'progress',
      collapseseries: '1',
    });

    expect(repository.findAudioBookIds).toHaveBeenCalledWith(
      3,
      expect.objectContaining({ sort: 'updatedAt', desc: true, limit: 10, offset: 20 }),
      user.contentFilters,
    );
    expect(result).toMatchObject({
      total: 2,
      limit: 10,
      page: 2,
      offset: 20,
      sortBy: 'updatedAt',
      sortDesc: true,
      filterBy: 'series.foo',
      minified: true,
      collapseseries: true,
      include: 'progress',
    });
  });

  it('supports ABS item sort names while falling back safely for unknown values', async () => {
    const { service, repository } = createService();

    await service.getItemsPage(user, 3, { sort: 'media.metadata.publishedYear' });
    expect(repository.findAudioBookIds).toHaveBeenLastCalledWith(3, expect.objectContaining({ sort: 'publishedYear' }), user.contentFilters);

    await service.getItemsPage(user, 3, { sort: 'not-a-sort' });
    expect(repository.findAudioBookIds).toHaveBeenLastCalledWith(3, expect.objectContaining({ sort: 'title' }), user.contentFilters);
  });
});

describe('AudiobookshelfLibrariesService personalized shelves', () => {
  it('returns only non-empty, library-scoped shelves with bounded entities', async () => {
    const { service, repository, itemsService } = createService();
    repository.findItemsInProgressForAudiobookshelfUser.mockResolvedValue([{ bookId: 1, progressLastUpdate: new Date(3000) }]);
    repository.countItemsInProgressForAudiobookshelfUser.mockResolvedValue(4);
    repository.findAudioBookIds.mockResolvedValue([2]);
    repository.countAudioBooks.mockResolvedValue(8);
    itemsService.getMinifiedItemsByIds.mockImplementation((bookIds: number[]) => Promise.resolve(bookIds.map((id) => ({ id: toAbsUuid(id) }))));

    await expect(service.getPersonalized(user, 3, 20)).resolves.toEqual([
      {
        id: 'continue-listening',
        label: 'Continue Listening',
        labelStringKey: 'LabelContinueListening',
        type: 'book',
        entities: [{ id: toAbsUuid(1), progressLastUpdate: 3000 }],
        total: 4,
      },
      {
        id: 'recently-added',
        label: 'Recently Added',
        labelStringKey: 'LabelRecentlyAdded',
        type: 'book',
        entities: [{ id: toAbsUuid(2) }],
        total: 8,
      },
    ]);
    expect(repository.findItemsInProgressForAudiobookshelfUser).toHaveBeenCalledWith(user, 20, 3);
    expect(repository.countItemsInProgressForAudiobookshelfUser).toHaveBeenCalledWith(user, 3);
    expect(repository.findAudioBookIds).toHaveBeenCalledWith(3, { limit: 20, offset: 0, sort: 'addedAt', desc: true }, user.contentFilters);
    expect(repository.countAudioBooks).toHaveBeenCalledWith(3, undefined, user.contentFilters);
  });

  it('omits empty shelves and clamps the requested limit', async () => {
    const { service, repository } = createService();
    repository.findAudioBookIds.mockResolvedValue([]);

    await expect(service.getPersonalized(user, 3, 1000)).resolves.toEqual([]);
    expect(repository.findItemsInProgressForAudiobookshelfUser).toHaveBeenCalledWith(user, 100, 3);
    expect(repository.findAudioBookIds).toHaveBeenCalledWith(3, { limit: 100, offset: 0, sort: 'addedAt', desc: true }, user.contentFilters);
  });
});

describe('AudiobookshelfLibrariesService library details', () => {
  it('returns a single exposed library', async () => {
    const { service, repository } = createService();

    const result = await service.getLibrary(user, 3);

    expect(repository.isLibraryExposedForUser).toHaveBeenCalledWith(3, 7, false);
    expect(repository.findLibraryById).toHaveBeenCalledWith(3);
    expect(result).toMatchObject({ id: expect.any(String), name: 'Audiobooks', mediaType: 'book', folders: [] });
    expect(result).not.toHaveProperty('filterdata');
  });

  it('returns ABS expanded envelope when filterdata is included', async () => {
    const { service, repository } = createService();
    vi.spyOn(service, 'getFilterData').mockResolvedValue({
      authors: [],
      genres: [],
      tags: [],
      series: [],
      narrators: [],
      languages: [],
      publishers: [],
      publishedDecades: [],
      bookCount: 0,
      authorCount: 0,
      seriesCount: 0,
      podcastCount: 0,
      numIssues: 0,
      loadedAt: 1000,
    });

    const result = await service.getLibrary(user, 3, 'progress, filterdata');

    expect(repository.findFoldersByLibraryIds).toHaveBeenCalledWith([3]);
    expect(result).toMatchObject({ issues: 0, numUserPlaylists: 0, filterdata: { bookCount: 0 } });
    expect(result).toHaveProperty('library.name', 'Audiobooks');
  });
});
