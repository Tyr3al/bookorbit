import { describe, expect, it, vi } from 'vitest';

import type { RequestUser } from '../../../common/types/request-user';
import { AudiobookshelfLibrariesService } from './audiobookshelf-libraries.service';

const user = { id: 7, isSuperuser: false, contentFilters: {} } as RequestUser;

function createService() {
  const repository = {
    isLibraryExposedForUser: vi.fn().mockResolvedValue(true),
    countAudioBooks: vi.fn().mockResolvedValue(2),
    findAudioBookIds: vi.fn().mockResolvedValue([1, 2]),
  };
  const itemsService = { getMinifiedItemsByIds: vi.fn().mockResolvedValue([]) };
  return { service: new AudiobookshelfLibrariesService(repository as never, itemsService as never), repository };
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
