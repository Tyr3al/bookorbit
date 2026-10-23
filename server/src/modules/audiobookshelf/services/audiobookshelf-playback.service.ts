import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';

import { sanitizeLogValue } from '../../../common/utils/log-sanitize.utils';
import { fromAudiobookshelfCompositeUuid, toAudiobookshelfCompositeUuid, toAudiobookshelfUuid } from '../../../common/utils/audiobookshelf-id.utils';
import type { RequestUser } from '../../../common/types/request-user';
import { AUDIOBOOKSHELF_SERVER_VERSION } from '../audiobookshelf.constants';
import type {
  AudiobookshelfFileMetadata,
  AudiobookshelfLibraryItem,
  AudiobookshelfPlaybackAudioTrack,
  AudiobookshelfPlaybackSessionExpanded,
} from '../audiobookshelf.types';
import { AudiobookshelfItemsService } from './audiobookshelf-items.service';
import { AudiobookshelfProgressService, type AppliedMediaProgress, type UpdateProgressInput } from './audiobookshelf-progress.service';
import { AudiobookshelfSessionsService, readDeviceId } from './audiobookshelf-sessions.service';
import { AudiobookshelfOpenSessionStore } from './audiobookshelf-open-session.store';

/** Builds the expanded direct-play session returned by ABS's play endpoint. */
@Injectable()
export class AudiobookshelfPlaybackService {
  private readonly logger = new Logger(AudiobookshelfPlaybackService.name);

  constructor(
    private readonly itemsService: AudiobookshelfItemsService,
    private readonly progressService: AudiobookshelfProgressService,
    private readonly sessionsService: AudiobookshelfSessionsService,
    private readonly openSessions: AudiobookshelfOpenSessionStore,
  ) {}

  async play(user: RequestUser, bookId: number, request: unknown): Promise<AudiobookshelfPlaybackSessionExpanded> {
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
      this.openSessions.open(session.id, {
        userId: user.id,
        bookId,
        isSuperuser: user.isSuperuser,
        deviceKey: readDeviceId(asRecord(request)?.deviceInfo),
      });
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
    const applied = await this.progressService.applyMediaProgress(user, bookId, input);
    await this.recordListening(user, sessionId, request, applied);
    this.openSessions.touch(sessionId);
  }

  async close(user: RequestUser, sessionId: string, request: unknown): Promise<void> {
    const bookId = this.requireOwnedSession(user, sessionId);
    const input = toProgressInput(request);
    if (hasProgressPosition(input)) {
      const applied = await this.progressService.applyMediaProgress(user, bookId, input);
      await this.recordListening(user, sessionId, request, applied);
    } else {
      await this.itemsService.requireExposedBook(user, bookId);
    }
    this.openSessions.close(sessionId);
  }

  private requireOwnedSession(user: RequestUser, sessionId: string): number {
    const session = fromAudiobookshelfCompositeUuid(sessionId);
    if (!session || session.a !== user.id) throw new NotFoundException('Session not found');
    return session.b;
  }

  /** Feeds the listening the client reported since its last sync into the reading history. ABS
   * sends it as `timeListened` on sync/close; some clients use `timeListening`. */
  private async recordListening(user: RequestUser, sessionId: string, request: unknown, applied: AppliedMediaProgress): Promise<void> {
    const requestRecord = asRecord(request);
    await this.sessionsService.recordLiveListening(user, {
      bookId: applied.bookId,
      bookFileId: applied.currentFileId,
      listenedSeconds: numericField(requestRecord?.timeListened) ?? numericField(requestRecord?.timeListening) ?? 0,
      startProgress: applied.previousPercentage,
      endProgress: applied.percentage,
      deviceKey: this.openSessions.get(sessionId)?.deviceKey ?? null,
      now: new Date(),
    });
  }

  private buildSession(
    user: RequestUser,
    bookId: number,
    sourceItem: AudiobookshelfLibraryItem,
    request: unknown,
    currentTime: number,
    now: number,
  ): AudiobookshelfPlaybackSessionExpanded {
    const item = sanitizeLibraryItem(sourceItem);
    const metadata = sourceItem.media.metadata;
    const deviceInfo = sanitizeDeviceInfo(request);
    const requestRecord = asRecord(request);
    const mediaPlayer = typeof requestRecord?.mediaPlayer === 'string' ? requestRecord.mediaPlayer.slice(0, 100) : 'unknown';
    const date = new Date(now);
    const duration = sourceItem.media.duration;

    return {
      id: toAudiobookshelfCompositeUuid(user.id, bookId),
      userId: toAudiobookshelfUuid(user.id),
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
      serverVersion: AUDIOBOOKSHELF_SERVER_VERSION,
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

function toPlaybackTrack(track: AudiobookshelfLibraryItem['media']['tracks'][number]): AudiobookshelfPlaybackAudioTrack {
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

function sanitizeLibraryItem(item: AudiobookshelfLibraryItem): AudiobookshelfLibraryItem {
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

function sanitizeFileMetadata(metadata: AudiobookshelfFileMetadata): AudiobookshelfFileMetadata {
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
