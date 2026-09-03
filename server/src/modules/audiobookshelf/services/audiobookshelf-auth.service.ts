import { Injectable, UnauthorizedException } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import { LoginDto } from '../../auth/dto/login.dto';
import { AuthService } from '../../auth/auth.service';
import { AudiobookshelfProgressService } from './audiobookshelf-progress.service';
import { AudiobookshelfLibrariesService } from './audiobookshelf-libraries.service';
import { AudiobookshelfBookmarksService } from './audiobookshelf-bookmarks.service';
import { UserService } from '../../user/user.service';
import type { AudiobookshelfLoginResponse, AudiobookshelfPermissions, AudiobookshelfUser } from '../audiobookshelf.types';
import type { RequestUser } from '../../../common/types/request-user';
import { toAudiobookshelfUuid } from '../../../common/utils/audiobookshelf-id.utils';
import { AUDIOBOOKSHELF_SERVER_VERSION } from '../audiobookshelf.constants';

/** The subset of user data the ABS payloads need; satisfied by RequestUser and by AuthService responses. */
type AudiobookshelfUserSource = Pick<RequestUser, 'id' | 'username' | 'email' | 'isSuperuser' | 'active'> & {
  settings: unknown;
  permissions: readonly string[];
  contentFilters?: RequestUser['contentFilters'];
};

@Injectable()
export class AudiobookshelfAuthService {
  constructor(
    private readonly authService: AuthService,
    private readonly userService: UserService,
    private readonly progressService: AudiobookshelfProgressService,
    private readonly librariesService: AudiobookshelfLibrariesService,
    private readonly bookmarksService: AudiobookshelfBookmarksService,
  ) {}

  /** POST /login: password login returning an ABS-shaped user with the long-lived token. */
  async login(dto: LoginDto, reply: FastifyReply, ip?: string, source?: string, returnTokens?: boolean): Promise<AudiobookshelfLoginResponse> {
    const { accessToken, rawRefreshToken, legacyToken, user } = await this.authService.loginForAudiobookshelf(dto, reply, ip, returnTokens);
    return this.buildLoginResponse(user, accessToken, rawRefreshToken, source, legacyToken);
  }

  /** POST /auth/refresh: rotate the refresh token and return a fresh token pair. */
  async refresh(rawRefreshToken: string | undefined, reply: FastifyReply): Promise<AudiobookshelfLoginResponse> {
    const { accessToken, rawRefreshToken: nextRefreshToken, userId } = await this.authService.refreshForAudiobookshelf(rawRefreshToken ?? '', reply);
    const user = await this.userService.findByIdWithPermissions(userId);
    if (!user) throw new UnauthorizedException();
    const userSource: AudiobookshelfUserSource = {
      id: user.id,
      username: user.username,
      email: user.email,
      isSuperuser: user.isSuperuser,
      active: user.active,
      settings: user.settings,
      permissions: user.permissions,
      contentFilters: user.contentFilters,
    };
    return this.buildLoginResponse(userSource, accessToken, nextRefreshToken);
  }

  /** GET /api/authorize: re-validate the presented token and return the user payload. */
  async authorize(user: RequestUser, token?: string): Promise<AudiobookshelfLoginResponse> {
    return this.buildLoginResponse(user, token);
  }

  /** GET /api/me: the user payload without a fresh token. */
  async me(user: RequestUser, token?: string): Promise<AudiobookshelfUser> {
    const response = await this.buildLoginResponse(user, token);
    return response.user;
  }

  private async buildLoginResponse(
    user: AudiobookshelfUserSource,
    accessToken?: string,
    refreshToken?: string | null,
    source?: string,
    legacyToken?: string,
  ): Promise<AudiobookshelfLoginResponse> {
    const mediaProgress = await this.progressService.getMediaProgressForUser(user);
    const [{ libraries }, { bookmarks }] = await Promise.all([this.librariesService.findLibraries(user), this.bookmarksService.getBookmarks(user)]);
    const isSuperuser = user.isSuperuser;
    const permissions = this.buildPermissions(user);

    const absUser: AudiobookshelfUser = {
      id: toAudiobookshelfUuid(user.id),
      username: user.username,
      email: user.email ?? '',
      type: isSuperuser ? 'root' : 'user',
      token: legacyToken ?? accessToken ?? '',
      accessToken: accessToken ?? '',
      refreshToken: refreshToken ?? null,
      mediaProgress,
      seriesHideFromContinueListening: [],
      bookmarks,
      permissions,
      isActive: user.active,
      isLocked: false,
      lastSeen: null,
      createdAt: 0,
      librariesAccessible: isSuperuser ? [] : libraries.map((library) => library.id),
      itemTagsSelected: [],
      hasOpenIDLink: false,
    };

    return {
      user: absUser,
      userDefaultLibraryId: libraries[0]?.id ?? null,
      serverSettings: {
        id: 'settings',
        scannerFindCovers: false,
        scannerCoverProvider: 'google',
        scannerParseSubtitle: false,
        scannerPreferMatchedMetadata: false,
        scannerDisableWatcher: true,
        storeCoverWithItem: false,
        storeMetadataWithItem: false,
        metadataFileFormat: 'json',
        rateLimitLoginRequests: 3,
        rateLimitLoginWindow: 5 * 60 * 1000,
        allowIframe: false,
        backupPath: '',
        backupSchedule: false,
        backupsToKeep: 0,
        maxBackupSize: 0,
        loggerDailyLogsToKeep: 14,
        loggerScannerLogsToKeep: 7,
        // Wire types match ABS: homeBookshelfView/bookshelfView/logLevel/buildNumber are
        // integer enums/indexes, podcastEpisodeSchedule is a cron string, authLoginCustomMessage null.
        homeBookshelfView: 1,
        bookshelfView: 1,
        podcastEpisodeSchedule: '0 0 * * *',
        sortingIgnorePrefix: false,
        sortingPrefixes: ['the', 'a'],
        chromecastEnabled: true,
        dateFormat: 'MM/dd/yyyy',
        timeFormat: 'hh:mm a',
        language: 'en-us',
        allowedOrigins: [],
        logLevel: 2,
        version: AUDIOBOOKSHELF_SERVER_VERSION,
        buildNumber: 1,
        authLoginCustomMessage: null,
        authActiveAuthMethods: ['local'],
        authOpenIDIssuerURL: null,
        authOpenIDAuthorizationURL: null,
        authOpenIDTokenURL: null,
        authOpenIDUserInfoURL: null,
        authOpenIDJwksURL: null,
        authOpenIDLogoutURL: null,
        authOpenIDTokenSigningAlgorithm: 'RS256',
        authOpenIDButtonText: 'Login with OpenId',
        authOpenIDAutoLaunch: false,
        authOpenIDAutoRegister: false,
        authOpenIDMatchExistingBy: null,
        timeZone: safeHostTimeZone(),
      },
      ereaderDevices: [],
      Source: source ?? '',
    };
  }

  private buildPermissions(user: AudiobookshelfUserSource): AudiobookshelfPermissions {
    if (user.isSuperuser) {
      return {
        download: true,
        update: true,
        delete: true,
        upload: true,
        createEreader: false,
        accessAllLibraries: true,
        accessAllTags: true,
        accessExplicitContent: true,
        selectedTagsNotAccessible: false,
      };
    }
    const permissions = new Set(user.permissions);
    const has = (name: string) => permissions.has(name);
    return {
      download: has('library_download'),
      update: has('library_edit_metadata'),
      delete: has('library_delete_books'),
      upload: has('library_upload'),
      createEreader: false,
      accessAllLibraries: false,
      accessAllTags: false,
      accessExplicitContent: true,
      selectedTagsNotAccessible: false,
    };
  }
}

function safeHostTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
