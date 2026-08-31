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
    countAudioBooksByLibraries: vi.fn().mockResolvedValue(2),
    findAuthorsWithCountsByLibraries: vi.fn().mockResolvedValue([]),
    findSeriesByLibraries: vi.fn().mockResolvedValue([]),
    findNarratorsWithCountsByLibraries: vi.fn().mockResolvedValue([]),
    findLibraryFilterAggregates: vi.fn().mockResolvedValue({
      genres: [],
      languages: [],
      publishers: [],
      publishedYears: [],
      missingCount: 0,
    }),
    findItemsInProgressForAudiobookshelfUser: vi.fn().mockResolvedValue([]),
    findAudioBookSearchIds: vi.fn().mockResolvedValue([]),
    findSeriesByLibrariesPage: vi.fn().mockResolvedValue({ rows: [], total: 0 }),
    findAuthorsWithCountsByLibrariesPage: vi.fn().mockResolvedValue({ rows: [], total: 0 }),
    findSeriesMembershipBookIdsByLibraries: vi.fn().mockResolvedValue([]),
    findGenresWithCountsByLibraries: vi.fn().mockResolvedValue([]),
    findTagsWithCountsByLibraries: vi.fn().mockResolvedValue([]),
  };
  const itemsService = { getMinifiedItemsByIds: vi.fn().mockResolvedValue([]), getItemsByIds: vi.fn().mockResolvedValue([]) };
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

describe('AudiobookshelfLibrariesService search', () => {
  it('returns the six upstream keys, wraps books as libraryItem, and clamps the limit into every category query', async () => {
    const { service, repository, itemsService } = createService();
    repository.findAudioBookSearchIds.mockResolvedValue([1]);
    itemsService.getItemsByIds.mockResolvedValue([{ id: toAbsUuid(1) }]);
    repository.findAuthorsWithCountsByLibrariesPage.mockResolvedValue({ rows: [{ id: 2, name: 'Author', numBooks: 1 }], total: 1 });
    repository.findNarratorsWithCountsByLibraries.mockResolvedValue([{ id: 3, name: 'Narrator', numBooks: 1 }]);
    repository.findGenresWithCountsByLibraries.mockResolvedValue([{ name: 'Sci-Fi', numItems: 1 }]);
    repository.findTagsWithCountsByLibraries.mockResolvedValue([{ name: 'favorite', numItems: 1 }]);

    const result = await service.searchLibrary(user, 3, 'dune', 5000);

    expect(result).toEqual({
      book: [{ libraryItem: { id: toAbsUuid(1) } }],
      narrators: [{ name: 'Narrator', numBooks: 1 }],
      tags: [{ name: 'favorite', numItems: 1 }],
      genres: [{ name: 'Sci-Fi', numItems: 1 }],
      series: [],
      authors: [expect.objectContaining({ name: 'Author', numBooks: 1 })],
    });
    expect(result).not.toHaveProperty('author');
    expect(result).not.toHaveProperty('podcast');
    expect(result).not.toHaveProperty('episode');

    expect(repository.findAudioBookSearchIds).toHaveBeenCalledWith(3, 'dune', 100, user.contentFilters);
  });

  it('drops a matched series that has no accessible books', async () => {
    const { service, repository, itemsService } = createService();
    repository.findSeriesByLibrariesPage.mockResolvedValue({ rows: [{ id: 10, name: 'Empty Series' }], total: 1 });
    repository.findSeriesMembershipBookIdsByLibraries.mockResolvedValue([]);
    itemsService.getMinifiedItemsByIds.mockResolvedValue([]);

    const result = await service.searchLibrary(user, 3, 'dune');

    expect(result.series).toEqual([]);
  });

  it('keeps a matched series that has at least one accessible book', async () => {
    const { service, repository, itemsService } = createService();
    repository.findSeriesByLibrariesPage.mockResolvedValue({ rows: [{ id: 10, name: 'Dune Saga' }], total: 1 });
    repository.findSeriesMembershipBookIdsByLibraries.mockResolvedValue([{ seriesId: 10, bookId: 1 }]);
    itemsService.getMinifiedItemsByIds.mockResolvedValue([{ id: toAbsUuid(1) }]);

    const result = await service.searchLibrary(user, 3, 'dune');

    expect(result.series).toEqual([{ series: expect.objectContaining({ name: 'Dune Saga' }), books: [{ id: toAbsUuid(1) }] }]);
  });

  it('clamps the requested limit and passes it into every repository call', async () => {
    const { service, repository } = createService();

    await service.searchLibrary(user, 3, 'dune', 5000);

    expect(repository.findAudioBookSearchIds).toHaveBeenCalledWith(3, 'dune', 100, user.contentFilters);
    expect(repository.findSeriesByLibrariesPage).toHaveBeenCalledWith([3], user.contentFilters, 100, 0, 'name', false, 'dune');
    expect(repository.findAuthorsWithCountsByLibrariesPage).toHaveBeenCalledWith([3], user.contentFilters, 100, 0, 'name', false, 'dune');
    expect(repository.findNarratorsWithCountsByLibraries).toHaveBeenCalledWith([3], user.contentFilters, 'dune', 100);
    expect(repository.findGenresWithCountsByLibraries).toHaveBeenCalledWith([3], user.contentFilters, 'dune', 100);
    expect(repository.findTagsWithCountsByLibraries).toHaveBeenCalledWith([3], user.contentFilters, 'dune', 100);
  });
});

describe('AudiobookshelfLibrariesService filter data', () => {
  it('uses the persisted library update timestamp for stable payloads', async () => {
    const { service } = createService();

    const first = await service.getFilterData(user, 3);
    const second = await service.getFilterData(user, 3);

    expect(first.loadedAt).toBe(library.updatedAt.getTime());
    expect(second).toEqual(first);
  });

  it('takes bookCount from the SQL count aggregate rather than materializing book ids', async () => {
    const { service, repository } = createService();
    repository.countAudioBooksByLibraries.mockResolvedValue(12345);

    const result = await service.getFilterData(user, 3);

    expect(repository.countAudioBooksByLibraries).toHaveBeenCalledWith([3], user.contentFilters);
    expect(result.bookCount).toBe(12345);
  });
});
