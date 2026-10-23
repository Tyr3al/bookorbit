import { randomUUID } from 'node:crypto';

import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { type ConfigType } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { StringValue } from 'ms';

import type { NativeCredentials } from '@bookorbit/types';
import { authConfig } from '../../../config/config';

import { LoginDto } from '../../auth/dto/login.dto';
import { AuthService } from '../../auth/auth.service';
import { AudiobookshelfProgressService } from './audiobookshelf-progress.service';
import { AudiobookshelfLibrariesService } from './audiobookshelf-libraries.service';
import { AudiobookshelfBookmarksService } from './audiobookshelf-bookmarks.service';
import { UserService } from '../../user/user.service';
import type { AudiobookshelfLoginResponse, AudiobookshelfPermissions, AudiobookshelfUser } from '../audiobookshelf.types';
import type { RequestUser } from '../../../common/types/request-user';
import { toAudiobookshelfUuid } from '../../../common/utils/audiobookshelf-id.utils';
import { AUDIOBOOKSHELF_DEVICE_LABEL, AUDIOBOOKSHELF_SERVER_VERSION } from '../audiobookshelf.constants';

/** The subset of user data the ABS payloads need; satisfied by RequestUser and by AuthService responses. */
type AudiobookshelfUserSource = Pick<RequestUser, 'id' | 'username' | 'email' | 'isSuperuser' | 'active'> & {
  settings: unknown;
  permissions: readonly string[];
  contentFilters?: RequestUser['contentFilters'];
};

interface AudiobookshelfTokens {
  accessToken: string;
  refreshToken: string;
  legacyToken: string;
}

@Injectable()
export class AudiobookshelfAuthService {
  constructor(
    private readonly authService: AuthService,
    private readonly jwtService: JwtService,
    @Inject(authConfig.KEY) private readonly config: ConfigType<typeof authConfig>,
    private readonly userService: UserService,
    private readonly progressService: AudiobookshelfProgressService,
    private readonly librariesService: AudiobookshelfLibrariesService,
    private readonly bookmarksService: AudiobookshelfBookmarksService,
  ) {}

  /** POST /login: password login returning an ABS-shaped user with ABS-shaped tokens. Backed by a
   * regular native BookOrbit auth session, so revocation, token versioning and the session list
   * apply to ABS clients exactly as they do to the native app. */
  async login(dto: LoginDto, reply: FastifyReply, ip?: string, source?: string): Promise<AudiobookshelfLoginResponse> {
    const { user, tokens } = await this.issueTokens(dto, reply, ip);
    return this.buildLoginResponse(user, tokens.accessToken, tokens.refreshToken, source, tokens.legacyToken);
  }

  /** Access token handed to the ABS OAuth mobile flow as its `code`. */
  async issueOAuthCode(dto: LoginDto, reply: FastifyReply, ip?: string): Promise<string> {
    const { tokens } = await this.issueTokens(dto, reply, ip);
    return tokens.accessToken;
  }

  /** POST /auth/refresh: rotate the session's refresh token and return a fresh token pair. */
  async refresh(rawRefreshToken: string | undefined, request: FastifyRequest, reply: FastifyReply): Promise<AudiobookshelfLoginResponse> {
    const sessionRefreshToken = this.unwrapRefreshToken(rawRefreshToken);
    const credentials = await this.authService.refresh(request, reply, { refreshToken: sessionRefreshToken });
    if (!('refreshToken' in credentials)) throw new UnauthorizedException();
    const { sub } = this.jwtService.decode<{ sub: number }>(credentials.accessToken);
    const user = await this.userService.findByIdWithPermissions(sub);
    if (!user) throw new UnauthorizedException();
    const tokens = this.toAudiobookshelfTokens(credentials, user);
    return this.buildLoginResponse(toUserSource(user), tokens.accessToken, tokens.refreshToken, undefined, tokens.legacyToken);
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

  private async issueTokens(dto: LoginDto, reply: FastifyReply, ip?: string) {
    const result = await this.authService.login({ ...dto, clientKind: 'native', deviceLabel: AUDIOBOOKSHELF_DEVICE_LABEL }, reply, ip);
    if (!('refreshToken' in result)) throw new UnauthorizedException();
    const user = result.user;
    return { user, tokens: this.toAudiobookshelfTokens(result, user) };
  }

  /**
   * ABS clients (Prologue) decode both tokens and read userId/username/jti/type claims, so the
   * session's tokens are re-signed with the ABS claim set. The access and legacy tokens keep
   * `sub`/`ver`/`amr`/`sid` so the regular JWT strategy validates them against the session. The
   * refresh token wraps the session's opaque refresh token, which is what rotation actually checks.
   */
  private toAudiobookshelfTokens(credentials: NativeCredentials, user: { id: number; username: string }): AudiobookshelfTokens {
    const { sub, ver, amr, sid } = this.jwtService.decode<{ sub: number; ver: number; amr: string; sid: number }>(credentials.accessToken);
    const identity = { sub, ver, amr, sid, userId: toAudiobookshelfUuid(user.id), username: user.username };
    const refreshExpiresInSeconds = Math.max(1, Math.floor((new Date(credentials.refreshTokenExpiresAt).getTime() - Date.now()) / 1000));
    return {
      accessToken: this.jwtService.sign(
        { ...identity, jti: randomUUID(), type: 'access' },
        { expiresIn: this.config.jwtAbsExpiresIn as StringValue },
      ),
      refreshToken: this.jwtService.sign(
        { userId: identity.userId, username: user.username, jti: randomUUID(), type: 'refresh', rt: credentials.refreshToken },
        { expiresIn: refreshExpiresInSeconds },
      ),
      // Real ABS's legacy `user.token` has no expiry. It is still bound to the auth session, so it
      // stops working once that session is revoked or lapses.
      legacyToken: this.jwtService.sign(identity, { expiresIn: '100y' }),
    };
  }

  private unwrapRefreshToken(token: string | undefined): string {
    if (!token) throw new UnauthorizedException();
    try {
      const payload = this.jwtService.verify<{ type?: unknown; rt?: unknown }>(token);
      if (payload.type !== 'refresh' || typeof payload.rt !== 'string' || !payload.rt) throw new UnauthorizedException();
      return payload.rt;
    } catch {
      throw new UnauthorizedException();
    }
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

function toUserSource(user: NonNullable<Awaited<ReturnType<UserService['findByIdWithPermissions']>>>): AudiobookshelfUserSource {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    isSuperuser: user.isSuperuser,
    active: user.active,
    settings: user.settings,
    permissions: user.permissions,
    contentFilters: user.contentFilters,
  };
}

function safeHostTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
