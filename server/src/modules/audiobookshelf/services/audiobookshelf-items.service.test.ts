import { BadRequestException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { toAbsUuid } from '../../../common/utils/abs-id.utils';
import type { RequestUser } from '../../../common/types/request-user';
import { AudiobookshelfItemsService } from './audiobookshelf-items.service';

const user = { id: 7, isSuperuser: false, contentFilters: {} } as RequestUser;

function createService(accessibleBooks: { id: number }[]) {
  const repository = {
    findExposedAudioBooksByIds: vi.fn().mockResolvedValue(accessibleBooks),
    findMetadataByBookIds: vi.fn().mockResolvedValue([]),
    findAudioFilesByBookIds: vi.fn().mockResolvedValue([]),
    findAuthorsByBookIds: vi.fn().mockResolvedValue([]),
    findNarratorsByBookIds: vi.fn().mockResolvedValue([]),
    findSeriesByBookIds: vi.fn().mockResolvedValue([]),
    findGenresByBookIds: vi.fn().mockResolvedValue([]),
  };
  const mapper = { toLibraryItem: vi.fn((input) => ({ id: toAbsUuid(input.book.id) })) };
  const service = new AudiobookshelfItemsService(repository as never, mapper as never, {} as never);
  return { service, repository, mapper };
}

describe('AudiobookshelfItemsService.getBatchItems', () => {
  it('validates access in one repository call and preserves request order', async () => {
    const { service, repository } = createService([{ id: 2 }, { id: 1 }]);

    const result = await service.getBatchItems(user, [toAbsUuid(1), toAbsUuid(2)]);

    expect(repository.findExposedAudioBooksByIds).toHaveBeenCalledOnce();
    expect(repository.findExposedAudioBooksByIds).toHaveBeenCalledWith([1, 2], user);
    expect(result.map((item) => item.id)).toEqual([toAbsUuid(1), toAbsUuid(2)]);
  });

  it('rejects malformed and duplicate ids with bad request', async () => {
    const { service } = createService([]);

    await expect(service.getBatchItems(user, ['invalid'])).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.getBatchItems(user, [toAbsUuid(1), toAbsUuid(1)])).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects inaccessible or missing items without partial results', async () => {
    const { service, mapper } = createService([{ id: 1 }]);

    await expect(service.getBatchItems(user, [toAbsUuid(1), toAbsUuid(2)])).rejects.toBeInstanceOf(NotFoundException);
    expect(mapper.toLibraryItem).not.toHaveBeenCalled();
  });

  it('rejects batches larger than the compatibility limit', async () => {
    const { service } = createService([]);

    await expect(
      service.getBatchItems(
        user,
        Array.from({ length: 101 }, (_, index) => toAbsUuid(index + 1)),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
