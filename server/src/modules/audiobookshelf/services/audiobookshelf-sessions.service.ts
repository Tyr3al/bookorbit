import { Injectable } from '@nestjs/common';

import { toAbsUuid } from '../../../common/utils/abs-id.utils';
import type { RequestUser } from '../../../common/types/request-user';
import type { AbsListeningSessionRow, NewAbsListeningSession } from '../../../db/schema';
import {
  ABS_DEFAULT_SESSIONS_PAGE_SIZE,
  ABS_MAX_SESSIONS_PAGE_SIZE,
  ABS_RECENT_SESSIONS_LIMIT,
  ABS_SERVER_VERSION,
} from '../audiobookshelf.constants';
import type { AbsListeningSessionsEnvelope, AbsListeningStats, AbsPlaybackSession } from '../audiobookshelf.types';
import { AudiobookshelfItemsService } from './audiobookshelf-items.service';
import { AudiobookshelfSessionsRepository } from './audiobookshelf-sessions.repository';

export interface RecordPlaybackStartInput {
  bookId: number;
  libraryId: number;
  displayTitle: string;
  displayAuthor: string;
  coverPath: string | null;
  duration: number | null;
  mediaPlayer: string;
  deviceInfo: Record<string, unknown> | null;
  mediaMetadata: Record<string, unknown>;
  currentTime: number;
  now: Date;
}

export interface RecordPlaybackSyncInput {
  timeListeningDelta: number;
  currentTime?: number;
  now: Date;
}

export interface RecordLocalSessionInput {
  bookId: number;
  libraryId: number;
  displayTitle: string;
  displayAuthor: string;
  duration: number | null;
  mediaPlayer: string;
  deviceInfo: Record<string, unknown> | null;
  timeListening: number;
  currentTime: number;
  startedAt: Date;
  updatedAt: Date;
}

/** Persists and reads Audiobookshelf-compatible listening-session history. Separate from the
 * stateless live playback handshake in AudiobookshelfPlaybackService - see that service and
 * AbsListeningSessionRow for the split between the deterministic live handle and this table's
 * 'live'/'local' rows. Write methods here can throw; callers (playback/progress services) are
 * responsible for logging and swallowing failures so a session-persistence error never breaks
 * playback or progress sync for the client. */
@Injectable()
export class AudiobookshelfSessionsService {
  constructor(
    private readonly repository: AudiobookshelfSessionsRepository,
    private readonly itemsService: AudiobookshelfItemsService,
  ) {}

  async recordPlaybackStart(userId: number, input: RecordPlaybackStartInput): Promise<void> {
    const { date, dayOfWeek } = deriveDateFields(input.now);
    await this.repository.upsertLiveSession(userId, {
      bookId: input.bookId,
      libraryId: input.libraryId,
      displayTitle: input.displayTitle,
      displayAuthor: input.displayAuthor,
      coverPath: input.coverPath,
      duration: input.duration,
      mediaPlayer: input.mediaPlayer,
      deviceInfo: input.deviceInfo,
      mediaMetadata: input.mediaMetadata,
      serverVersion: ABS_SERVER_VERSION,
      date,
      dayOfWeek,
      currentTime: input.currentTime,
      now: input.now,
    });
  }

  async recordPlaybackSync(userId: number, bookId: number, input: RecordPlaybackSyncInput): Promise<void> {
    await this.repository.accumulateLiveSession(userId, bookId, input);
  }

  async recordLocalSessions(userId: number, entries: RecordLocalSessionInput[]): Promise<void> {
    if (entries.length === 0) return;
    const rows: NewAbsListeningSession[] = entries.map((entry) => {
      const { date, dayOfWeek } = deriveDateFields(entry.updatedAt);
      // currentTime/startTime/timeListening all back the CHECK constraints on the table, so clamp
      // at this persistence boundary too - not just in the callers - so a hostile or buggy client
      // payload cannot fail the whole batch insert.
      const currentTime = Math.max(0, entry.currentTime);
      return {
        userId,
        bookId: entry.bookId,
        libraryId: entry.libraryId,
        source: 'local',
        displayTitle: entry.displayTitle,
        displayAuthor: entry.displayAuthor,
        coverPath: null,
        duration: entry.duration,
        mediaPlayer: entry.mediaPlayer,
        deviceInfo: entry.deviceInfo,
        mediaMetadata: {},
        serverVersion: ABS_SERVER_VERSION,
        date,
        dayOfWeek,
        timeListening: Math.max(0, Math.round(entry.timeListening)),
        startTime: currentTime,
        currentTime,
        startedAt: entry.startedAt,
        updatedAt: entry.updatedAt,
      };
    });
    await this.repository.insertLocalSessions(rows);
  }

  /** ABS GET /api/me/listening-sessions. */
  async getSessionsPage(user: RequestUser, page: number, itemsPerPage: number): Promise<AbsListeningSessionsEnvelope> {
    const bounded = boundPagination(page, itemsPerPage);
    const { rows, total } = await this.repository.findPage(user.id, bounded.limit, bounded.offset);
    return toEnvelope(rows, total, bounded);
  }

  /** ABS GET /api/me/item/listening-sessions/:libraryItemId - 404s via requireExposedBook when
   * the item does not exist or the user cannot access it. */
  async getItemSessionsPage(user: RequestUser, bookId: number, page: number, itemsPerPage: number): Promise<AbsListeningSessionsEnvelope> {
    await this.itemsService.requireExposedBook(user, bookId);
    const bounded = boundPagination(page, itemsPerPage);
    const { rows, total } = await this.repository.findPageForBook(user.id, bookId, bounded.limit, bounded.offset);
    return toEnvelope(rows, total, bounded);
  }

  /** ABS GET /api/me/listening-stats. totalTime/days/dayOfWeek/items are grouped SQL aggregates;
   * only recentSessions loads full rows, bounded to ABS_RECENT_SESSIONS_LIMIT. */
  async getListeningStats(user: RequestUser): Promise<AbsListeningStats> {
    const today = deriveDateFields(new Date()).date;
    const [aggregate, recentRows] = await Promise.all([
      this.repository.findStatsAggregate(user.id, today),
      this.repository.findRecent(user.id, ABS_RECENT_SESSIONS_LIMIT),
    ]);

    const mediaMetadataByBookId = new Map(aggregate.itemMediaMetadata.map((row) => [row.bookId, row.mediaMetadata]));
    const items: AbsListeningStats['items'] = {};
    for (const row of aggregate.items) {
      items[toAbsUuid(row.bookId)] = {
        id: toAbsUuid(row.bookId),
        timeListening: row.timeListening,
        mediaMetadata: mediaMetadataByBookId.get(row.bookId) ?? {},
        lastUpdate: row.lastUpdate.getTime(),
      };
    }

    const days: Record<string, number> = {};
    for (const row of aggregate.days) days[row.date] = row.seconds;

    const dayOfWeek: Record<string, number> = {};
    for (const row of aggregate.dayOfWeek) dayOfWeek[row.dayOfWeek] = row.seconds;

    return {
      totalTime: aggregate.totals.totalTime,
      items,
      days,
      dayOfWeek,
      today: aggregate.totals.today,
      recentSessions: recentRows.map(toAbsPlaybackSession),
    };
  }
}

function boundPagination(page: number, itemsPerPage: number): { page: number; itemsPerPage: number; limit: number; offset: number } {
  const boundedItemsPerPage = clampInt(itemsPerPage, 1, ABS_MAX_SESSIONS_PAGE_SIZE, ABS_DEFAULT_SESSIONS_PAGE_SIZE);
  const boundedPage = Number.isFinite(page) && page >= 0 ? Math.floor(page) : 0;
  return { page: boundedPage, itemsPerPage: boundedItemsPerPage, limit: boundedItemsPerPage, offset: boundedPage * boundedItemsPerPage };
}

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value) || value < min) return fallback;
  return Math.min(Math.floor(value), max);
}

function toEnvelope(rows: AbsListeningSessionRow[], total: number, bounded: { page: number; itemsPerPage: number }): AbsListeningSessionsEnvelope {
  return {
    total,
    numPages: bounded.itemsPerPage > 0 ? Math.ceil(total / bounded.itemsPerPage) : 0,
    page: bounded.page,
    itemsPerPage: bounded.itemsPerPage,
    sessions: rows.map(toAbsPlaybackSession),
  };
}

function toAbsPlaybackSession(row: AbsListeningSessionRow): AbsPlaybackSession {
  return {
    id: toAbsUuid(row.id),
    userId: toAbsUuid(row.userId),
    libraryId: toAbsUuid(row.libraryId),
    libraryItemId: toAbsUuid(row.bookId),
    bookId: toAbsUuid(row.bookId),
    episodeId: null,
    mediaType: 'book',
    mediaMetadata: row.mediaMetadata ?? {},
    chapters: null,
    displayTitle: row.displayTitle,
    displayAuthor: row.displayAuthor,
    coverPath: row.coverPath,
    duration: row.duration,
    playMethod: row.playMethod,
    mediaPlayer: row.mediaPlayer,
    deviceInfo: row.deviceInfo ?? null,
    serverVersion: row.serverVersion,
    date: row.date,
    dayOfWeek: row.dayOfWeek,
    timeListening: row.timeListening,
    startTime: row.startTime,
    currentTime: row.currentTime,
    startedAt: row.startedAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

function deriveDateFields(value: Date): { date: string; dayOfWeek: string } {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  const dayOfWeek = new Intl.DateTimeFormat('en-US', { weekday: 'long' }).format(value);
  return { date: `${year}-${month}-${day}`, dayOfWeek };
}
