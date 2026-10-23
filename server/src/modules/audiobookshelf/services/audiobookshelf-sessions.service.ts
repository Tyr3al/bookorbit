import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';

import { toAudiobookshelfUuid } from '../../../common/utils/audiobookshelf-id.utils';
import { sanitizeLogValue } from '../../../common/utils/log-sanitize.utils';
import { resolveTimeZone, toDateKeyInTimeZone } from '../../../common/utils/timezone.utils';
import type { RequestUser } from '../../../common/types/request-user';
import { ReadingSessionService } from '../../reading-session/reading-session.service';
import { AudiobookshelfRepository } from '../audiobookshelf.repository';
import {
  AUDIOBOOKSHELF_DEFAULT_SESSIONS_PAGE_SIZE,
  AUDIOBOOKSHELF_LIVE_SESSION_GAP_MS,
  AUDIOBOOKSHELF_MAX_SESSIONS_PAGE_SIZE,
  AUDIOBOOKSHELF_RECENT_SESSIONS_LIMIT,
  AUDIOBOOKSHELF_SERVER_VERSION,
} from '../audiobookshelf.constants';
import type { AudiobookshelfListeningSessionsEnvelope, AudiobookshelfListeningStats, AudiobookshelfPlaybackSession } from '../audiobookshelf.types';
import { AudiobookshelfItemsService } from './audiobookshelf-items.service';
import { AudiobookshelfSessionsRepository, type ListeningSessionRow } from './audiobookshelf-sessions.repository';

const LIVE_SESSION_ID_PREFIX = 'abs-live:';
const LOCAL_SESSION_ID_PREFIX = 'abs-local:';
const DEFAULT_DEVICE_KEY = 'default';
/** ABS sessions carry no source of their own (see the class comment); this device-key prefix is
 * what identifies them. */
const SOURCE_DEVICE_KEY_PREFIX = 'abs:';

export interface LiveListeningReport {
  bookId: number;
  bookFileId: number;
  /** Seconds the client says it listened since its previous report. */
  listenedSeconds: number;
  /** Book percentage (0-100) before and after this report's position was applied. */
  startProgress: number | null;
  endProgress: number | null;
  deviceKey: string | null;
  now: Date;
}

export interface LocalListeningSession {
  bookId: number;
  bookFileId: number;
  clientSessionId: string | null;
  startedAt: Date;
  updatedAt: Date;
  timeListening: number;
  startProgress: number | null;
  endProgress: number | null;
  deviceKey: string | null;
}

interface BookDisplay {
  title: string;
  subtitle: string | null;
  author: string;
  coverPath: string | null;
}

/**
 * Bridges ABS listening into BookOrbit's reading history. Every write lands in reading_sessions
 * as a 'listen' session, so it feeds the reading log, statistics, daily stats, achievements and
 * external trackers like any other session. Reads serve the ABS listening-session and stats routes
 * from the same table.
 *
 * Sessions are written with no source: the reading_sessions source list is upstream's, and adding
 * a value to it from this fork would break the next upstream migration that recreates that check
 * constraint. BookOrbit therefore counts ABS listening under its general bucket, and the `abs:`
 * device key is what tells these sessions apart.
 *
 * Write methods never throw: listening history is a side effect of play/sync, and a failure here
 * must not fail the progress write the client is waiting on.
 */
@Injectable()
export class AudiobookshelfSessionsService {
  private readonly logger = new Logger(AudiobookshelfSessionsService.name);

  constructor(
    private readonly repository: AudiobookshelfSessionsRepository,
    private readonly audiobookshelfRepository: AudiobookshelfRepository,
    private readonly itemsService: AudiobookshelfItemsService,
    private readonly readingSessions: ReadingSessionService,
  ) {}

  /**
   * Live play/sync/close reports listening in small deltas. Consecutive reports from one device
   * grow a single session until the device goes quiet for AUDIOBOOKSHELF_LIVE_SESSION_GAP_MS; the
   * next report then starts a new one. Looking the open session up in the table rather than in
   * memory keeps this correct across server restarts.
   */
  async recordLiveListening(user: RequestUser, report: LiveListeningReport): Promise<void> {
    if (!(report.listenedSeconds > 0)) return;
    const event = 'audiobookshelf.listening_session';
    const startedAtMs = Date.now();
    const sourceDeviceKey = toSourceDeviceKey(report.deviceKey);
    try {
      const open = await this.readingSessions.findLatestSourceSession({
        userId: user.id,
        bookId: report.bookId,
        sourceDeviceKey,
        sessionIdPrefix: LIVE_SESSION_ID_PREFIX,
        endedAfter: new Date(report.now.getTime() - AUDIOBOOKSHELF_LIVE_SESSION_GAP_MS),
      });
      const listened = Math.round(report.listenedSeconds);
      const startProgress = open ? sessionStartProgress(open.endProgress, open.progressDelta, report.startProgress) : report.startProgress;
      const result = await this.readingSessions.recordListeningSession({
        userId: user.id,
        bookFileId: report.bookFileId,
        sessionId: open?.sessionId ?? `${LIVE_SESSION_ID_PREFIX}${randomUUID()}`,
        startedAt: open?.startedAt ?? new Date(report.now.getTime() - listened * 1000),
        endedAt: report.now,
        durationSeconds: (open?.durationSeconds ?? 0) + listened,
        progressDelta: progressDelta(startProgress, report.endProgress),
        endProgress: report.endProgress,
        source: null,
        sourceDeviceKey,
        timeZone: userTimeZone(user),
      });
      if (result.kind === 'saved') {
        this.logger.log(
          `[${event}] [end] userId=${user.id} bookId=${report.bookId} durationMs=${Date.now() - startedAtMs} outcome=${result.kind} - listening session started`,
        );
      }
    } catch (error) {
      this.logFailure(event, user.id, report.bookId, startedAtMs, error);
    }
  }

  /**
   * Offline sessions uploaded by a client. The client re-uploads a session with growing totals as
   * playback continues, so the client's own session id is the idempotency key: a re-upload grows
   * the stored session and an identical retry is a no-op. Writes run one at a time, bounded by the
   * batch the client sent.
   */
  async recordLocalSessions(user: RequestUser, sessions: LocalListeningSession[]): Promise<void> {
    if (sessions.length === 0) return;
    const event = 'audiobookshelf.local_listening_sessions';
    const startedAtMs = Date.now();
    const timeZone = userTimeZone(user);
    let saved = 0;
    let grown = 0;
    let skipped = 0;
    let failed = 0;
    for (const session of sessions) {
      try {
        const result = await this.readingSessions.recordListeningSession({
          userId: user.id,
          bookFileId: session.bookFileId,
          sessionId: localSessionId(session),
          startedAt: session.startedAt,
          endedAt: session.updatedAt,
          durationSeconds: session.timeListening,
          progressDelta: progressDelta(session.startProgress, session.endProgress),
          endProgress: session.endProgress,
          source: null,
          sourceDeviceKey: toSourceDeviceKey(session.deviceKey),
          timeZone,
        });
        if (result.kind === 'saved') saved++;
        else if (result.kind === 'superseded') grown++;
        else skipped++;
      } catch (error) {
        failed++;
        this.logFailure(event, user.id, session.bookId, startedAtMs, error);
      }
    }
    this.logger.log(
      `[${event}] [end] userId=${user.id} entries=${sessions.length} durationMs=${Date.now() - startedAtMs} saved=${saved} grown=${grown} skipped=${skipped} failed=${failed} - local listening sessions recorded`,
    );
  }

  /** ABS GET /api/me/listening-sessions. */
  async getSessionsPage(user: RequestUser, page: number, itemsPerPage: number): Promise<AudiobookshelfListeningSessionsEnvelope> {
    const bounded = boundPagination(page, itemsPerPage);
    const { rows, total } = await this.repository.findPage(user, bounded.limit, bounded.offset);
    return this.toEnvelope(user, rows, total, bounded);
  }

  /** ABS GET /api/me/item/listening-sessions/:libraryItemId - 404s via requireExposedBook when
   * the item does not exist or the user cannot access it. */
  async getItemSessionsPage(user: RequestUser, bookId: number, page: number, itemsPerPage: number): Promise<AudiobookshelfListeningSessionsEnvelope> {
    await this.itemsService.requireExposedBook(user, bookId);
    const bounded = boundPagination(page, itemsPerPage);
    const { rows, total } = await this.repository.findPage(user, bounded.limit, bounded.offset, bookId);
    return this.toEnvelope(user, rows, total, bounded);
  }

  /** ABS GET /api/me/listening-stats. totalTime/days/dayOfWeek/items are grouped SQL aggregates;
   * only recentSessions loads full rows, bounded to AUDIOBOOKSHELF_RECENT_SESSIONS_LIMIT. */
  async getListeningStats(user: RequestUser): Promise<AudiobookshelfListeningStats> {
    const timeZone = userTimeZone(user);
    const today = toDateKeyInTimeZone(new Date(), timeZone);
    const [aggregate, recent] = await Promise.all([
      this.repository.findStatsAggregate(user, timeZone, today),
      this.repository.findPage(user, AUDIOBOOKSHELF_RECENT_SESSIONS_LIMIT, 0),
    ]);

    const displayByBookId = await this.loadBookDisplay([
      ...new Set([...aggregate.items.map((row) => row.bookId), ...recent.rows.map((row) => row.bookId)]),
    ]);
    const items: AudiobookshelfListeningStats['items'] = {};
    for (const row of aggregate.items) {
      const id = toAudiobookshelfUuid(row.bookId);
      items[id] = {
        id,
        timeListening: row.timeListening,
        mediaMetadata: toMediaMetadata(displayByBookId.get(row.bookId)),
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
      recentSessions: await this.toPlaybackSessions(user, recent.rows, displayByBookId),
    };
  }

  private async toEnvelope(
    user: RequestUser,
    rows: ListeningSessionRow[],
    total: number,
    bounded: { page: number; itemsPerPage: number },
  ): Promise<AudiobookshelfListeningSessionsEnvelope> {
    return {
      total,
      numPages: Math.ceil(total / bounded.itemsPerPage),
      page: bounded.page,
      itemsPerPage: bounded.itemsPerPage,
      sessions: await this.toPlaybackSessions(user, rows),
    };
  }

  private async toPlaybackSessions(
    user: RequestUser,
    rows: ListeningSessionRow[],
    knownDisplay?: Map<number, BookDisplay>,
  ): Promise<AudiobookshelfPlaybackSession[]> {
    if (rows.length === 0) return [];
    const bookIds = [...new Set(rows.map((row) => row.bookId))];
    const [displayByBookId, files] = await Promise.all([
      knownDisplay ?? this.loadBookDisplay(bookIds),
      this.audiobookshelfRepository.findAudioFilesByBookIds(bookIds),
    ]);
    const durationByBookId = new Map<number, number>();
    for (const file of files) durationByBookId.set(file.bookId, (durationByBookId.get(file.bookId) ?? 0) + (file.durationSeconds ?? 0));
    const timeZone = userTimeZone(user);
    return rows.map((row) => toPlaybackSession(user.id, row, displayByBookId.get(row.bookId), durationByBookId.get(row.bookId) || null, timeZone));
  }

  /** Title/author for a set of books in two batched queries, without building full library items,
   * because listening stats can span every audiobook the user has ever played. */
  private async loadBookDisplay(bookIds: number[]): Promise<Map<number, BookDisplay>> {
    if (bookIds.length === 0) return new Map();
    const [metadata, authors] = await Promise.all([
      this.audiobookshelfRepository.findMetadataByBookIds(bookIds),
      this.audiobookshelfRepository.findAuthorsByBookIds(bookIds),
    ]);
    const authorNames = new Map<number, string[]>();
    for (const author of authors) {
      const names = authorNames.get(author.bookId);
      if (names) names.push(author.name);
      else authorNames.set(author.bookId, [author.name]);
    }
    return new Map(
      metadata.map((row) => [
        row.bookId,
        {
          title: row.title ?? '',
          subtitle: row.subtitle ?? null,
          author: (authorNames.get(row.bookId) ?? []).join(', '),
          coverPath: row.coverSource ? `/metadata/items/${row.bookId}/cover.jpg` : null,
        },
      ]),
    );
  }

  private logFailure(event: string, userId: number, bookId: number, startedAtMs: number, error: unknown): void {
    const errorClass = error instanceof Error ? error.name : 'Error';
    const errorMessage = sanitizeLogValue(error instanceof Error ? error.message : String(error));
    this.logger.warn(
      `[${event}] [fail] userId=${userId} bookId=${bookId} durationMs=${Date.now() - startedAtMs} errorClass=${errorClass} error="${errorMessage}" - listening session persist failed`,
    );
  }
}

/** The client's device id from an ABS deviceInfo payload, used to keep sessions per device. */
export function readDeviceId(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const info = value as Record<string, unknown>;
  const id = typeof info.deviceId === 'string' && info.deviceId ? info.deviceId : typeof info.id === 'string' && info.id ? info.id : null;
  return id ? id.slice(0, 120) : null;
}

function toPlaybackSession(
  userId: number,
  row: ListeningSessionRow,
  display: BookDisplay | undefined,
  duration: number | null,
  timeZone: string,
): AudiobookshelfPlaybackSession {
  const startPercent = sessionStartProgress(row.endProgress, row.progressDelta, null);
  const positionAt = (percent: number | null) => (percent !== null && duration ? Math.max(0, (percent / 100) * duration) : 0);
  const isAbs = row.source === null && row.sourceDeviceKey?.startsWith(SOURCE_DEVICE_KEY_PREFIX) === true;
  return {
    id: toAudiobookshelfUuid(row.id),
    userId: toAudiobookshelfUuid(userId),
    libraryId: toAudiobookshelfUuid(row.libraryId),
    libraryItemId: toAudiobookshelfUuid(row.bookId),
    bookId: toAudiobookshelfUuid(row.bookId),
    episodeId: null,
    mediaType: 'book',
    mediaMetadata: toMediaMetadata(display),
    chapters: null,
    displayTitle: display?.title ?? '',
    displayAuthor: display?.author ?? '',
    coverPath: display?.coverPath ?? null,
    duration,
    playMethod: 0,
    mediaPlayer: isAbs ? 'audiobookshelf' : (row.source ?? 'bookorbit'),
    deviceInfo:
      isAbs && row.sourceDeviceKey !== toSourceDeviceKey(null) ? { deviceId: row.sourceDeviceKey!.slice(SOURCE_DEVICE_KEY_PREFIX.length) } : null,
    serverVersion: AUDIOBOOKSHELF_SERVER_VERSION,
    date: toDateKeyInTimeZone(row.startedAt, timeZone),
    dayOfWeek: new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone }).format(row.startedAt),
    timeListening: row.durationSeconds,
    startTime: positionAt(startPercent),
    currentTime: positionAt(row.endProgress),
    startedAt: row.startedAt.getTime(),
    updatedAt: row.endedAt.getTime(),
  };
}

function toMediaMetadata(display: BookDisplay | undefined): Record<string, unknown> {
  return display ? { title: display.title, subtitle: display.subtitle, author: display.author } : {};
}

function sessionStartProgress(endProgress: number | null, delta: number | null, fallback: number | null): number | null {
  return endProgress !== null && delta !== null ? endProgress - delta : fallback;
}

function progressDelta(start: number | null, end: number | null): number | null {
  return start !== null && end !== null ? Math.round((end - start) * 100) / 100 : null;
}

function localSessionId(session: LocalListeningSession): string {
  const clientId = session.clientSessionId?.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 50);
  return clientId ? `${LOCAL_SESSION_ID_PREFIX}${clientId}` : `${LOCAL_SESSION_ID_PREFIX}${session.bookId}-${session.startedAt.getTime()}`;
}

function toSourceDeviceKey(deviceKey: string | null): string {
  return `${SOURCE_DEVICE_KEY_PREFIX}${(deviceKey || DEFAULT_DEVICE_KEY).slice(0, 120)}`;
}

function userTimeZone(user: RequestUser): string {
  return resolveTimeZone((user.settings as { timezone?: unknown } | undefined)?.timezone, 'UTC');
}

function boundPagination(page: number, itemsPerPage: number): { page: number; itemsPerPage: number; limit: number; offset: number } {
  const boundedItemsPerPage = clampInt(itemsPerPage, 1, AUDIOBOOKSHELF_MAX_SESSIONS_PAGE_SIZE, AUDIOBOOKSHELF_DEFAULT_SESSIONS_PAGE_SIZE);
  const boundedPage = Number.isFinite(page) && page >= 0 ? Math.floor(page) : 0;
  return { page: boundedPage, itemsPerPage: boundedItemsPerPage, limit: boundedItemsPerPage, offset: boundedPage * boundedItemsPerPage };
}

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value) || value < min) return fallback;
  return Math.min(Math.floor(value), max);
}
