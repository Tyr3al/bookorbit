import { describe, expect, it, vi } from 'vitest';

import { NotFoundException } from '@nestjs/common';

import { AudiobookshelfAuthorsService } from './audiobookshelf-authors.service';
import type { RequestUser } from '../../../common/types/request-user';

const user = { id: 7, isSuperuser: false, contentFilters: {} } as RequestUser;
const author = { id: 3, name: 'Author', description: null, sortName: null, hasPhoto: false };

function createService() {
  const repository = {
    findAuthorsWithCountsByLibraries: vi.fn().mockResolvedValue([]),
    findAuthorsWithCountsByLibrariesPage: vi.fn().mockResolvedValue({ rows: [], total: 0 }),
    findAuthorsByIds: vi.fn().mockResolvedValue([author]),
    findAuthorBookIdsByLibraries: vi.fn().mockResolvedValue([11]),
    findAuthorBookStatsByLibraries: vi.fn().mockResolvedValue(undefined),
    findBooksByIds: vi.fn().mockResolvedValue([{ id: 11, libraryId: 10 }]),
  };
  const itemsService = { getMinifiedItemsByIds: vi.fn().mockResolvedValue([]) };
  const librariesService = {
    getExposedLibraryIds: vi.fn().mockResolvedValue([10]),
    requireExposedLibrary: vi.fn().mockResolvedValue(undefined),
  };
  const authorsService = { getImagePath: vi.fn() };
  return {
    service: new AudiobookshelfAuthorsService(repository as never, itemsService as never, librariesService as never, authorsService as never),
    repository,
    librariesService,
  };
}

describe('AudiobookshelfAuthorsService', () => {
  it('does not expose an author that has no accessible audio books', async () => {
    const { service, repository } = createService();
    repository.findAuthorBookIdsByLibraries.mockResolvedValue([]);

    await expect(service.getAuthor(user, 3)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns only the requested author books from the SQL-scoped query', async () => {
    const { service, repository } = createService();
    repository.findAuthorBookIdsByLibraries.mockResolvedValue([11, 12]);
    repository.findBooksByIds.mockResolvedValue([{ id: 11, libraryId: 10 }]);

    const result = await service.getAuthor(user, 3);

    expect(repository.findAuthorBookIdsByLibraries).toHaveBeenCalledWith(3, [10], user.contentFilters);
    expect(result).toMatchObject({ id: '00000000-0000-4000-8000-000000000003', libraryId: '00000000-0000-4000-8000-00000000000a' });
  });

  it('uses the SQL-bounded author page and preserves pagination metadata', async () => {
    const { service, repository } = createService();
    repository.findAuthorsWithCountsByLibrariesPage.mockResolvedValue({ rows: [author], total: 9 });

    await expect(service.listLibraryAuthors(user, 10, 2, 3, 'numBooks', true, 'issues', true, 'rssfeed')).resolves.toMatchObject({
      results: [{ id: '00000000-0000-4000-8000-000000000003' }],
      total: 9,
      limit: 2,
      page: 3,
      sortBy: 'numBooks',
      sortDesc: true,
      filterBy: 'issues',
      minified: true,
      include: 'rssfeed',
    });
    expect(repository.findAuthorsWithCountsByLibrariesPage).toHaveBeenCalledWith([10], user.contentFilters, 2, 6, 'numBooks', true);
    expect(repository.findAuthorsWithCountsByLibraries).not.toHaveBeenCalled();
  });

  it('keeps the bare response for an unpaginated author list', async () => {
    const { service, repository } = createService();
    repository.findAuthorsWithCountsByLibraries.mockResolvedValue([author]);

    await expect(service.listLibraryAuthors(user, 10)).resolves.toEqual({
      authors: [
        {
          id: '00000000-0000-4000-8000-000000000003',
          asin: null,
          name: 'Author',
          description: null,
          imagePath: null,
          addedAt: 0,
          updatedAt: 0,
          libraryId: '00000000-0000-4000-8000-00000000000a',
        },
      ],
    });
    expect(repository.findAuthorsWithCountsByLibraries).toHaveBeenCalledWith([10], user.contentFilters);
  });

  it('requires the requested library and scopes nested author details to it', async () => {
    const { service, repository, librariesService } = createService();

    const result = await service.getAuthor(user, 3, undefined, 10);

    expect(librariesService.requireExposedLibrary).toHaveBeenCalledWith(user, 10);
    expect(repository.findAuthorBookIdsByLibraries).toHaveBeenCalledWith(3, [10], user.contentFilters);
    expect(result).toMatchObject({ id: '00000000-0000-4000-8000-000000000003', libraryId: '00000000-0000-4000-8000-00000000000a' });
  });

  it('does not return an author from another library on the nested route', async () => {
    const { service, repository } = createService();
    repository.findAuthorBookIdsByLibraries.mockResolvedValue([]);

    await expect(service.getAuthor(user, 3, undefined, 99)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('surfaces the SQL-derived addedAt/updatedAt on the author detail response', async () => {
    const { service, repository } = createService();
    repository.findAuthorBookStatsByLibraries.mockResolvedValue({ addedAt: new Date(1000), updatedAt: new Date(2000) });

    const result = await service.getAuthor(user, 3);

    expect(repository.findAuthorBookStatsByLibraries).toHaveBeenCalledWith(3, [10], user.contentFilters);
    expect(result).toMatchObject({ addedAt: 1000, updatedAt: 2000 });
  });

  it('defaults author detail timestamps to 0 without crashing when no book stats are found', async () => {
    const { service, repository } = createService();
    repository.findAuthorBookStatsByLibraries.mockResolvedValue(undefined);

    const result = await service.getAuthor(user, 3);

    expect(result).toMatchObject({ addedAt: 0, updatedAt: 0 });
  });

  it('surfaces derived addedAt/updatedAt on the paginated author list', async () => {
    const { service, repository } = createService();
    repository.findAuthorsWithCountsByLibrariesPage.mockResolvedValue({
      rows: [{ ...author, addedAt: new Date(1000), updatedAt: new Date(2000) }],
      total: 1,
    });

    const result = await service.listLibraryAuthors(user, 10, 2, 0);

    expect(result).toMatchObject({ results: [{ addedAt: 1000, updatedAt: 2000 }] });
  });

  it('surfaces derived addedAt/updatedAt on the unpaginated author list without crashing when a row has no stats', async () => {
    const { service, repository } = createService();
    repository.findAuthorsWithCountsByLibraries.mockResolvedValue([{ ...author, id: 4, addedAt: new Date(1000), updatedAt: new Date(2000) }, author]);

    const result = await service.listLibraryAuthors(user, 10);

    expect(result).toEqual({
      authors: [
        expect.objectContaining({ id: '00000000-0000-4000-8000-000000000004', addedAt: 1000, updatedAt: 2000 }),
        expect.objectContaining({ id: '00000000-0000-4000-8000-000000000003', addedAt: 0, updatedAt: 0 }),
      ],
    });
  });
});
