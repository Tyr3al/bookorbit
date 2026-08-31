import { describe, expect, it, vi } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { Permission } from '@bookorbit/types';

import { AudiobookshelfAuthService } from './audiobookshelf-auth.service';

describe('AudiobookshelfAuthService', () => {
  it('includes the canonical user permissions when refreshing a token', async () => {
    const userService = {
      findByIdWithPermissions: vi.fn().mockResolvedValue({
        id: 7,
        username: 'reader',
        name: 'Reader',
        email: 'reader@example.com',
        active: true,
        isSuperuser: false,
        isDefaultPassword: false,
        tokenVersion: 1,
        settings: {},
        avatarUrl: null,
        provisioningMethod: 'local',
        permissions: [Permission.LibraryDownload],
        contentFilters: {},
      }),
    };
    const authService = {
      refreshForAudiobookshelf: vi.fn().mockResolvedValue({
        accessToken: 'access',
        rawRefreshToken: 'refresh',
        userId: 7,
      }),
    };
    const progressService = { getMediaProgressForUser: vi.fn().mockResolvedValue([]) };
    const librariesService = { findLibraries: vi.fn().mockResolvedValue({ libraries: [] }) };
    const bookmarksService = { getBookmarks: vi.fn().mockResolvedValue({ bookmarks: [] }) };
    const service = new AudiobookshelfAuthService(
      authService as never,
      userService as never,
      progressService as never,
      librariesService as never,
      bookmarksService as never,
    );

    const result = await service.refresh('presented-refresh', {} as never);

    expect(userService.findByIdWithPermissions).toHaveBeenCalledWith(7);
    expect(progressService.getMediaProgressForUser).toHaveBeenCalledWith(expect.objectContaining({ id: 7, contentFilters: {} }));
    expect(result.user.permissions).toEqual({
      download: true,
      update: false,
      delete: false,
      upload: false,
      createEreader: false,
      accessAllLibraries: false,
      accessAllTags: false,
      accessExplicitContent: true,
      selectedTagsNotAccessible: false,
    });
  });

  it('rejects refresh when the canonical user no longer exists', async () => {
    const userService = { findByIdWithPermissions: vi.fn().mockResolvedValue(null) };
    const authService = {
      refreshForAudiobookshelf: vi.fn().mockResolvedValue({ accessToken: 'access', rawRefreshToken: 'refresh', userId: 7 }),
    };
    const service = new AudiobookshelfAuthService(authService as never, userService as never, {} as never, {} as never, {} as never);

    await expect(service.refresh('presented-refresh', {} as never)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
