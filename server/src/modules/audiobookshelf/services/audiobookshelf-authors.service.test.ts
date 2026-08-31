import { describe, expect, it, vi } from 'vitest';

import { NotFoundException } from '@nestjs/common';

import { AudiobookshelfAuthorsService } from './audiobookshelf-authors.service';
import type { RequestUser } from '../../../common/types/request-user';

const user = { id: 7, isSuperuser: false, contentFilters: {} } as RequestUser;
const author = { id: 3, name: 'Author', description: null, sortName: null, hasPhoto: false };

function createService() {
  const repository = {
    findAuthorsByIds: vi.fn().mockResolvedValue([author]),
    findAudioBookIdsByLibraries: vi.fn().mockResolvedValue([11]),
    findAuthorIdsByBookIds: vi.fn().mockResolvedValue([{ bookId: 11, authorId: 3 }]),
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
    repository.findAudioBookIdsByLibraries.mockResolvedValue([]);

    await expect(service.getAuthor(user, 3)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('requires the requested library and scopes nested author details to it', async () => {
    const { service, repository, librariesService } = createService();

    const result = await service.getAuthor(user, 3, undefined, 10);

    expect(librariesService.requireExposedLibrary).toHaveBeenCalledWith(user, 10);
    expect(repository.findAudioBookIdsByLibraries).toHaveBeenCalledWith([10], user.contentFilters);
    expect(result).toMatchObject({ id: '00000000-0000-4000-8000-000000000003', libraryId: '00000000-0000-4000-8000-00000000000a' });
  });

  it('does not return an author from another library on the nested route', async () => {
    const { service, repository } = createService();
    repository.findAudioBookIdsByLibraries.mockResolvedValue([]);

    await expect(service.getAuthor(user, 3, undefined, 99)).rejects.toBeInstanceOf(NotFoundException);
  });
});
