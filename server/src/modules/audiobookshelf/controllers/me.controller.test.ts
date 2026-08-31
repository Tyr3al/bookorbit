import { describe, expect, it, vi } from 'vitest';

import type { RequestUser } from '../../../common/types/request-user';
import { MeController } from './me.controller';

function user(): RequestUser {
  return {
    id: 7,
    username: 'listener',
    name: 'Listener',
    email: null,
    active: true,
    isSuperuser: false,
    isDefaultPassword: false,
    tokenVersion: 1,
    settings: {},
    avatarUrl: null,
    provisioningMethod: 'local',
    permissions: [],
    contentFilters: { includeTagIds: [], includeGenreIds: [], excludeTagIds: [], excludeGenreIds: [] },
  };
}

describe('MeController', () => {
  it('returns all visible media progress for GET /api/me/progress', async () => {
    const progress = [{ libraryItemId: 'book-1', progress: 0.5 }];
    const progressService = { getMediaProgressForUser: vi.fn().mockResolvedValue(progress) };
    const controller = new MeController({} as never, progressService as never, {} as never);

    await expect(controller.getAllProgress(user())).resolves.toEqual({ mediaProgress: progress });
    expect(progressService.getMediaProgressForUser).toHaveBeenCalledWith(user());
  });

  it('returns library items for GET /api/me/items-in-progress', async () => {
    const result = { libraryItems: [{ id: 'book-1', progressLastUpdate: 123 }] };
    const progressService = { getItemsInProgress: vi.fn().mockResolvedValue(result) };
    const controller = new MeController({} as never, progressService as never, {} as never);

    await expect(controller.getItemsInProgress(user(), '40')).resolves.toEqual(result);
    expect(progressService.getItemsInProgress).toHaveBeenCalledWith(user(), 40);
  });

  it('returns the ABS plain success body after deleting progress', async () => {
    const progressService = { deleteMediaProgress: vi.fn().mockResolvedValue(undefined) };
    const controller = new MeController({} as never, progressService as never, {} as never);
    const currentUser = user();

    await expect(controller.deleteProgress(currentUser, 'progress-id')).resolves.toBe('OK');
    expect(progressService.deleteMediaProgress).toHaveBeenCalledWith(currentUser, 'progress-id');
  });
});
