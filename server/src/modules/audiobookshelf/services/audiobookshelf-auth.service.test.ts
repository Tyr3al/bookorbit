import { describe, expect, it, vi } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Permission } from '@bookorbit/types';

import { toAudiobookshelfUuid } from '../../../common/utils/audiobookshelf-id.utils';
import { AUDIOBOOKSHELF_DEVICE_LABEL } from '../audiobookshelf.constants';
import { AudiobookshelfAuthService } from './audiobookshelf-auth.service';

const jwt = new JwtService({ secret: 'test-secret', signOptions: { expiresIn: '15m', algorithm: 'HS256' } });

function sessionCredentials(refreshToken = 'session-refresh') {
  return {
    accessToken: jwt.sign({ sub: 7, ver: 3, amr: 'password', sid: 42 }),
    accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
    refreshToken,
    refreshTokenExpiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    sessionId: 42,
  };
}

const canonicalUser = {
  id: 7,
  username: 'reader',
  email: 'reader@example.com',
  active: true,
  isSuperuser: false,
  tokenVersion: 3,
  settings: {},
  permissions: [Permission.LibraryDownload],
  contentFilters: {},
};

function makeService(overrides: { authService?: object; userService?: object } = {}) {
  const authService = {
    login: vi.fn().mockResolvedValue({ ...sessionCredentials(), user: canonicalUser }),
    refresh: vi.fn().mockResolvedValue(sessionCredentials('rotated-refresh')),
    ...overrides.authService,
  };
  const userService = { findByIdWithPermissions: vi.fn().mockResolvedValue(canonicalUser), ...overrides.userService };
  const progressService = { getMediaProgressForUser: vi.fn().mockResolvedValue([]) };
  const librariesService = { findLibraries: vi.fn().mockResolvedValue({ libraries: [] }) };
  const bookmarksService = { getBookmarks: vi.fn().mockResolvedValue({ bookmarks: [] }) };
  const service = new AudiobookshelfAuthService(
    authService as never,
    jwt,
    { jwtAbsExpiresIn: '30d' } as never,
    userService as never,
    progressService as never,
    librariesService as never,
    bookmarksService as never,
  );
  return { service, authService, userService, progressService };
}

describe('AudiobookshelfAuthService', () => {
  it('logs in through a native auth session and re-signs its tokens with ABS claims', async () => {
    const { service, authService } = makeService();

    const result = await service.login({ username: 'reader', password: 'pw' }, {} as never, '127.0.0.1');

    expect(authService.login).toHaveBeenCalledWith(
      { username: 'reader', password: 'pw', clientKind: 'native', deviceLabel: AUDIOBOOKSHELF_DEVICE_LABEL },
      {},
      '127.0.0.1',
    );
    const access = jwt.verify(result.user.accessToken);
    expect(access).toMatchObject({ sub: 7, ver: 3, amr: 'password', sid: 42, userId: toAudiobookshelfUuid(7), username: 'reader', type: 'access' });
    expect(jwt.verify(result.user.token)).toMatchObject({ sub: 7, sid: 42, userId: toAudiobookshelfUuid(7) });
    expect(jwt.verify(result.user.refreshToken!)).toMatchObject({ type: 'refresh', rt: 'session-refresh', username: 'reader' });
  });

  it('refreshes by unwrapping the session refresh token and includes canonical permissions', async () => {
    const { service, authService, userService, progressService } = makeService();
    const presented = jwt.sign({ type: 'refresh', rt: 'session-refresh' });
    const request = { cookies: {} };

    const result = await service.refresh(presented, request as never, {} as never);

    expect(authService.refresh).toHaveBeenCalledWith(request, {}, { refreshToken: 'session-refresh' });
    expect(userService.findByIdWithPermissions).toHaveBeenCalledWith(7);
    expect(progressService.getMediaProgressForUser).toHaveBeenCalledWith(expect.objectContaining({ id: 7, contentFilters: {} }));
    expect(jwt.verify(result.user.refreshToken!)).toMatchObject({ rt: 'rotated-refresh' });
    expect(result.user.permissions).toMatchObject({ download: true, update: false, delete: false, accessAllLibraries: false });
  });

  it.each([
    ['a missing token', undefined],
    ['a non-JWT token', 'opaque'],
    ['an access token', jwt.sign({ type: 'access', rt: 'session-refresh' })],
  ])('rejects refresh with %s', async (_label, token) => {
    const { service, authService } = makeService();

    await expect(service.refresh(token, {} as never, {} as never)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(authService.refresh).not.toHaveBeenCalled();
  });

  it('rejects refresh when the canonical user no longer exists', async () => {
    const { service } = makeService({ userService: { findByIdWithPermissions: vi.fn().mockResolvedValue(null) } });

    await expect(service.refresh(jwt.sign({ type: 'refresh', rt: 'x' }), {} as never, {} as never)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
