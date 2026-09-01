import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';

import { sanitizeLogValue } from '../../../common/utils/log-sanitize.utils';
import { fromAbsCompositeUuid, fromAbsUuid, toAbsCompositeUuid, toAbsUuid } from '../../../common/utils/abs-id.utils';
import type { RequestUser } from '../../../common/types/request-user';
import { ABS_SERVER_VERSION } from '../audiobookshelf.constants';
import type { AbsFileMetadata, AbsLibraryItem, AbsPlaybackAudioTrack, AbsPlaybackSessionExpanded } from '../audiobookshelf.types';
import { AudiobookshelfItemsService } from './audiobookshelf-items.service';
import { AudiobookshelfProgressService, type UpdateProgressInput } from './audiobookshelf-progress.service';
import { AudiobookshelfSessionsService } from './audiobookshelf-sessions.service';
import { AbsOpenSessionStore } from './abs-open-session.store';

/** Builds the expanded direct-play session returned by ABS's play endpoint. */
@Injectable()
export class AudiobookshelfPlaybackService {
  private readonly logger = new Logger(AudiobookshelfPlaybackService.name);

  constructor(
    private readonly itemsService: AudiobookshelfItemsService,
    private readonly progressService: AudiobookshelfProgressService,
    private readonly sessionsService: AudiobookshelfSessionsService,
    private readonly openSessions: AbsOpenSessionStore,
  ) {}

  async play(user: RequestUser, bookId: number, request: unknown): Promise<AbsPlaybackSessionExpanded> {
    const startedAt = Date.now();
    const event = 'audiobookshelf.playback';
    this.logger.log(`[${event}] [start] userId=${user.id} bookId=${bookId} - playback session start requested`);

    try {
      const item = await this.itemsService.getItem(user, bookId);
      const progress = await this.progressService.getMediaProgress(user, bookId);
      if (item.media.tracks.length === 0) throw new NotFoundException(`Book ${bookId} has no audio tracks`);
      const currentTime = clampPlaybackTime(progress?.isFinished ? 0 : (progress?.currentTime ?? 0), item.media.duration);
      const now = Date.now();
      const session = this.buildSession(user, bookId, item, request, currentTime, now);
      this.openSessions.open(session.id, { userId: user.id, bookId, isSuperuser: user.isSuperuser });
      await this.persistLiveSessionStart(user, bookId, item, session, currentTime, new Date(now));
      this.logger.log(
        `[${event}] [end] userId=${user.id} bookId=${bookId} durationMs=${Date.now() - startedAt} tracks=${session.audioTracks.length} - playback session started`,
      );
      return session;
    } catch (error) {
      const errorClass = error instanceof Error ? error.name : 'Error';
      const errorMessage = sanitizeLogValue(error instanceof Error ? error.message : String(error));
      this.logger.warn(
        `[${event}] [fail] userId=${user.id} bookId=${bookId} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${errorMessage}" - playback session failed`,
      );
      throw error;
    }
  }

  async sync(user: RequestUser, sessionId: string, request: unknown): Promise<void> {
    const bookId = this.requireOwnedSession(user, sessionId);
    const input = toProgressInput(request);
    if (!hasProgressPosition(input)) throw new BadRequestException('Playback position is required');
    await this.progressService.updateMediaProgress(user, bookId, input);
    await this.persistLiveSessionSync(user, bookId, request, input);
    this.openSessions.touch(sessionId);
  }

  async close(user: RequestUser, sessionId: string, request: unknown): Promise<void> {
    const bookId = this.requireOwnedSession(user, sessionId);
    const input = toProgressInput(request);
    if (hasProgressPosition(input)) {
      await this.progressService.updateMediaProgress(user, bookId, input);
    } else {
      await this.itemsService.requireExposedBook(user, bookId);
    }
    await this.persistLiveSessionSync(user, bookId, request, input);
    this.openSessions.close(sessionId);
  }

  private requireOwnedSession(user: RequestUser, sessionId: string): number {
    const session = fromAbsCompositeUuid(sessionId);
    if (!session || session.a !== user.id) throw new NotFoundException('Session not found');
    return session.b;
  }

  /** Opens/refreshes the historical 'live' session row for this user+book. Never throws - a
   * persistence failure here must not break the play() response the client is waiting on. */
  private async persistLiveSessionStart(
    user: RequestUser,
    bookId: number,
    item: AbsLibraryItem,
    session: AbsPlaybackSessionExpanded,
    currentTime: number,
    now: Date,
  ): Promise<void> {
    const event = 'audiobookshelf.playback_session';
    const startedAt = Date.now();
    try {
      await this.sessionsService.recordPlaybackStart(user.id, {
        bookId,
        libraryId: fromAbsUuid(item.libraryId) ?? 0,
        displayTitle: session.displayTitle,
        displayAuthor: session.displayAuthor,
        coverPath: session.coverPath,
        duration: session.duration,
        mediaPlayer: session.mediaPlayer,
        deviceInfo: session.deviceInfo,
        mediaMetadata: session.mediaMetadata,
        currentTime,
        now,
      });
    } catch (error) {
      const errorClass = error instanceof Error ? error.name : 'Error';
      const errorMessage = sanitizeLogValue(error instanceof Error ? error.message : String(error));
      this.logger.warn(
        `[${event}] [fail] userId=${user.id} bookId=${bookId} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${errorMessage}" - listening session persist failed`,
      );
    }
  }

  /** Accumulates timeListening on the live session row for sync/close. Never throws, for the
   * same reason as persistLiveSessionStart. Negative positions are clamped before they reach the
   * repository so a hostile client cannot trip the current_time CHECK constraint and drop the
   * whole UPDATE (including the positive timeListening delta). */
  private async persistLiveSessionSync(user: RequestUser, bookId: number, request: unknown, input: UpdateProgressInput): Promise<void> {
    const event = 'audiobookshelf.playback_session';
    const startedAt = Date.now();
    try {
      const requestRecord = asRecord(request);
      const timeListeningDelta = numericField(requestRecord?.timeListened) ?? numericField(requestRecord?.timeListening) ?? 0;
      const currentTime = input.currentTime === undefined ? undefined : Math.max(0, input.currentTime);
      await this.sessionsService.recordPlaybackSync(user.id, bookId, { timeListeningDelta, currentTime, now: new Date() });
    } catch (error) {
      const errorClass = error instanceof Error ? error.name : 'Error';
      const errorMessage = sanitizeLogValue(error instanceof Error ? error.message : String(error));
      this.logger.warn(
        `[${event}] [fail] userId=${user.id} bookId=${bookId} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${errorMessage}" - listening session persist failed`,
      );
    }
  }

  private buildSession(
    user: RequestUser,
    bookId: number,
    sourceItem: AbsLibraryItem,
    request: unknown,
    currentTime: number,
    now: number,
  ): AbsPlaybackSessionExpanded {
    const item = sanitizeLibraryItem(sourceItem);
    const metadata = sourceItem.media.metadata;
    const deviceInfo = sanitizeDeviceInfo(request);
    const requestRecord = asRecord(request);
    const mediaPlayer = typeof requestRecord?.mediaPlayer === 'string' ? requestRecord.mediaPlayer.slice(0, 100) : 'unknown';
    const date = new Date(now);
    const duration = sourceItem.media.duration;

    return {
      id: toAbsCompositeUuid(user.id, bookId),
      userId: toAbsUuid(user.id),
      libraryId: sourceItem.libraryId,
      libraryItemId: sourceItem.id,
      bookId: sourceItem.media.id,
      episodeId: null,
      mediaType: 'book',
      mediaMetadata: {
        title: metadata.title,
        subtitle: metadata.subtitle,
        author: metadata.authorName,
        narrator: metadata.narratorName,
        series: metadata.seriesName,
        genres: metadata.genres,
        publishedYear: metadata.publishedYear,
        publishedDate: metadata.publishedDate,
        publisher: metadata.publisher,
        description: metadata.description,
        isbn: metadata.isbn,
        asin: metadata.asin,
        language: metadata.language,
      },
      chapters: item.media.chapters,
      displayTitle: metadata.title,
      displayAuthor: metadata.authorName,
      coverPath: item.media.coverPath,
      duration,
      playMethod: 0,
      mediaPlayer,
      deviceInfo,
      serverVersion: ABS_SERVER_VERSION,
      date: date.toISOString().slice(0, 10),
      dayOfWeek: new Intl.DateTimeFormat('en-US', { weekday: 'long' }).format(date),
      timeListening: 0,
      startTime: currentTime,
      currentTime,
      startedAt: now,
      updatedAt: now,
      audioTracks: sourceItem.media.tracks.map(toPlaybackTrack),
      libraryItem: item,
    };
  }
}

function toPlaybackTrack(track: AbsLibraryItem['media']['tracks'][number]): AbsPlaybackAudioTrack {
  return {
    index: track.index,
    startOffset: track.startOffset,
    duration: track.duration,
    title: track.title,
    contentUrl: track.contentUrl,
    mimeType: track.mimeType,
    codec: track.codec,
    metadata: sanitizeFileMetadata(track.metadata),
  };
}

function sanitizeLibraryItem(item: AbsLibraryItem): AbsLibraryItem {
  return {
    ...item,
    path: item.relPath,
    media: {
      ...item.media,
      audioFiles: item.media.audioFiles.map((file) => ({ ...file, metadata: sanitizeFileMetadata(file.metadata) })),
      tracks: item.media.tracks.map((track) => ({ ...track, metadata: sanitizeFileMetadata(track.metadata) })),
    },
    libraryFiles: item.libraryFiles.map((file) => ({ ...file, metadata: sanitizeFileMetadata(file.metadata) })),
  };
}

function sanitizeFileMetadata(metadata: AbsFileMetadata): AbsFileMetadata {
  return { ...metadata, path: metadata.relPath };
}

function sanitizeDeviceInfo(request: unknown): Record<string, unknown> | null {
  const input = asRecord(asRecord(request)?.deviceInfo);
  if (!input) return null;

  const output: Record<string, unknown> = {};
  for (const key of ['id', 'deviceId', 'clientName', 'clientVersion', 'manufacturer', 'model']) {
    if (typeof input[key] === 'string') output[key] = input[key].slice(0, 200);
  }
  if (typeof input.sdkVersion === 'number' && Number.isFinite(input.sdkVersion)) output.sdkVersion = input.sdkVersion;
  return output;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function toProgressInput(value: unknown): UpdateProgressInput {
  const source = asRecord(value);
  if (!source) return {};
  return {
    currentTime: numericField(source.currentTime),
    duration: numericField(source.duration),
    progress: numericField(source.progress),
    startedAt: numericField(source.startedAt),
    lastUpdate: numericField(source.lastUpdate) ?? numericField(source.updatedAt),
    isFinished: typeof source.isFinished === 'boolean' ? source.isFinished : undefined,
  };
}

function numericField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function hasProgressPosition(input: UpdateProgressInput): boolean {
  return input.currentTime !== undefined || input.progress !== undefined;
}

function clampPlaybackTime(currentTime: number, duration: number | null): number {
  if (!Number.isFinite(currentTime)) return 0;
  const nonNegative = Math.max(0, currentTime);
  return duration != null && Number.isFinite(duration) ? Math.min(nonNegative, Math.max(0, duration)) : nonNegative;
}
