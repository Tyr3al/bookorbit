import { describe, expect, it, vi } from 'vitest';

import { AudiobookshelfCollectionsService } from './audiobookshelf-collections.service';
import type { RequestUser } from '../../../common/types/request-user';

const user = { id: 7, isSuperuser: false, contentFilters: {} } as RequestUser;
const collection = {
  id: 3,
  userId: 7,
  name: 'Series collection',
  description: null,
  displayOrder: 0,
  createdAt: new Date(1000),
  updatedAt: new Date(2000),
};

function createService() {
  const repository = {
    findCollectionsByUserId: vi.fn().mockResolvedValue([collection]),
    findCollectionsByUserIdAndLibrary: vi.fn().mockResolvedValue([collection]),
    countCollectionsByUserIdAndLibrary: vi.fn().mockResolvedValue(1),
    findCollectionBookIdsByCollectionIds: vi.fn().mockResolvedValue([]),
    findCollectionBookIdsByCollectionIdsAndLibraries: vi.fn().mockResolvedValue([]),
    findAudioBookIdsByLibraries: vi.fn().mockResolvedValue([]),
  };
  const itemsService = { getItemsByIds: vi.fn().mockResolvedValue([]) };
  const librariesService = {
    requireExposedLibrary: vi.fn().mockResolvedValue(undefined),
    getExposedLibraryIds: vi.fn().mockResolvedValue([10, 20]),
  };
  return {
    service: new AudiobookshelfCollectionsService(repository as never, itemsService as never, librariesService as never),
    repository,
    librariesService,
  };
}

describe('AudiobookshelfCollectionsService', () => {
  it('scopes library collections before pagination and hydration', async () => {
    const { service, repository, librariesService } = createService();

    const result = await service.listLibraryCollections(user, 10, 5, 2);

    expect(librariesService.requireExposedLibrary).toHaveBeenCalledWith(user, 10);
    expect(repository.findCollectionsByUserIdAndLibrary).toHaveBeenCalledWith(user.id, 10, user.contentFilters, 5, 10);
    expect(repository.countCollectionsByUserIdAndLibrary).toHaveBeenCalledWith(user.id, 10, user.contentFilters);
    expect(repository.findCollectionBookIdsByCollectionIdsAndLibraries).toHaveBeenCalledWith([3], [10], user.contentFilters);
    expect(repository.findCollectionsByUserId).not.toHaveBeenCalled();
    expect(result).toMatchObject({ total: 1, page: 2, limit: 5, results: [{ name: collection.name }] });
  });

  it('keeps the global collection endpoint behavior unchanged', async () => {
    const { service, repository } = createService();

    await service.listCollections(user);

    expect(repository.findCollectionsByUserId).toHaveBeenCalledWith(user.id);
    expect(repository.findCollectionBookIdsByCollectionIds).toHaveBeenCalledWith([3]);
    expect(repository.findCollectionsByUserIdAndLibrary).not.toHaveBeenCalled();
  });
});
