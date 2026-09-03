import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { RequestUser } from '../../../common/types/request-user';
import { AudiobookshelfLibrariesController } from './audiobookshelf-libraries.controller';

const user = { id: 7, isSuperuser: false } as RequestUser;

describe('AudiobookshelfLibrariesController', () => {
  it('passes personalized shelf query parameters to the service', async () => {
    const personalized = vi.fn().mockResolvedValue([{ id: 'recently-added' }]);
    const controller = new AudiobookshelfLibrariesController(
      { getPersonalized: personalized } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(controller.personalized(user, '3', '25')).resolves.toEqual([{ id: 'recently-added' }]);
    expect(personalized).toHaveBeenCalledWith(user, 3, 25);
  });

  it('rejects a missing search query with a 400', () => {
    const searchLibrary = vi.fn();
    const controller = new AudiobookshelfLibrariesController({ searchLibrary } as never, {} as never, {} as never, {} as never, {} as never);

    expect(() => controller.search(user, '3', undefined, undefined)).toThrow(BadRequestException);
    expect(searchLibrary).not.toHaveBeenCalled();
  });

  it('rejects a blank (whitespace-only) search query with a 400', () => {
    const searchLibrary = vi.fn();
    const controller = new AudiobookshelfLibrariesController({ searchLibrary } as never, {} as never, {} as never, {} as never, {} as never);

    expect(() => controller.search(user, '3', '   ', undefined)).toThrow(BadRequestException);
    expect(searchLibrary).not.toHaveBeenCalled();
  });

  it('defaults the search limit to 12 and forwards the trimmed query', async () => {
    const searchLibrary = vi.fn().mockResolvedValue({ book: [] });
    const controller = new AudiobookshelfLibrariesController({ searchLibrary } as never, {} as never, {} as never, {} as never, {} as never);

    await controller.search(user, '3', 'dune', undefined);
    expect(searchLibrary).toHaveBeenCalledWith(user, 3, 'dune', 12);

    await controller.search(user, '3', 'dune', '25');
    expect(searchLibrary).toHaveBeenCalledWith(user, 3, 'dune', 25);
  });
});
