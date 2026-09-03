import { Inject, Injectable } from '@nestjs/common';
import { and, count, desc, eq, sql } from 'drizzle-orm';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { DB } from '../../../db';
import * as schema from '../../../db/schema';
import type { AudiobookshelfListeningSessionRow, NewAudiobookshelfListeningSession } from '../../../db/schema';

type Db = NodePgDatabase<typeof schema>;

export interface UpsertLiveSessionInput {
  bookId: number;
  libraryId: number;
  displayTitle: string;
  displayAuthor: string;
  coverPath: string | null;
  duration: number | null;
  mediaPlayer: string;
  deviceInfo: Record<string, unknown> | null;
  mediaMetadata: Record<string, unknown>;
  serverVersion: string;
  date: string;
  dayOfWeek: string;
  currentTime: number;
  now: Date;
}

export interface AccumulateLiveSessionInput {
  timeListeningDelta: number;
  currentTime?: number;
  now: Date;
}

export interface StatsTotals {
  totalTime: number;
  today: number;
}

export interface StatsDayRow {
  date: string;
  seconds: number;
}

export interface StatsDayOfWeekRow {
  dayOfWeek: string;
  seconds: number;
}

export interface StatsItemRow {
  bookId: number;
  timeListening: number;
  lastUpdate: Date;
}

export interface StatsItemMediaMetadataRow {
  bookId: number;
  mediaMetadata: Record<string, unknown>;
}

export interface StatsAggregate {
  totals: StatsTotals;
  days: StatsDayRow[];
  dayOfWeek: StatsDayOfWeekRow[];
  items: StatsItemRow[];
  itemMediaMetadata: StatsItemMediaMetadataRow[];
}

const { audiobookshelfListeningSessions } = schema;

@Injectable()
export class AudiobookshelfSessionsRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Opens the single 'live' row for this user+book if none exists yet, otherwise refreshes its
   * snapshot fields in place. The accumulated timeListening total is left untouched here - only
   * accumulateLiveSession() advances it. Atomic via the partial unique index on (userId, bookId)
   * where source='live', so concurrent play() calls for the same book cannot double-insert. */
  async upsertLiveSession(userId: number, input: UpsertLiveSessionInput): Promise<AudiobookshelfListeningSessionRow> {
    const snapshot = {
      libraryId: input.libraryId,
      displayTitle: input.displayTitle,
      displayAuthor: input.displayAuthor,
      coverPath: input.coverPath,
      duration: input.duration,
      mediaPlayer: input.mediaPlayer,
      deviceInfo: input.deviceInfo,
      mediaMetadata: input.mediaMetadata,
      serverVersion: input.serverVersion,
      date: input.date,
      dayOfWeek: input.dayOfWeek,
      startTime: input.currentTime,
      currentTime: input.currentTime,
      updatedAt: input.now,
    };

    const [row] = await this.db
      .insert(audiobookshelfListeningSessions)
      .values({ userId, bookId: input.bookId, source: 'live', timeListening: 0, startedAt: input.now, ...snapshot })
      .onConflictDoUpdate({
        target: [audiobookshelfListeningSessions.userId, audiobookshelfListeningSessions.bookId],
        targetWhere: sql`${audiobookshelfListeningSessions.source} = 'live'`,
        set: snapshot,
      })
      .returning();
    return row;
  }

  /** Advances the live row's accumulated listening time and current position. A no-op (0 rows
   * matched) when no live row exists yet for this user+book - sync/close can be called without a
   * prior successful play() write. */
  async accumulateLiveSession(userId: number, bookId: number, input: AccumulateLiveSessionInput): Promise<void> {
    const setValues: Record<string, unknown> = { updatedAt: input.now };
    if (input.timeListeningDelta > 0) {
      setValues.timeListening = sql`${audiobookshelfListeningSessions.timeListening} + ${Math.round(input.timeListeningDelta)}`;
    }
    if (input.currentTime !== undefined) setValues.currentTime = input.currentTime;

    await this.db
      .update(audiobookshelfListeningSessions)
      .set(setValues)
      .where(
        and(
          eq(audiobookshelfListeningSessions.userId, userId),
          eq(audiobookshelfListeningSessions.bookId, bookId),
          eq(audiobookshelfListeningSessions.source, 'live'),
        ),
      );
  }

  /** Bulk-inserts discrete offline sessions uploaded by a client - one write for the whole
   * batch, never one write per entry. */
  async insertLocalSessions(rows: NewAudiobookshelfListeningSession[]): Promise<void> {
    if (rows.length === 0) return;
    await this.db.insert(audiobookshelfListeningSessions).values(rows);
  }

  async findPage(userId: number, limit: number, offset: number): Promise<{ rows: AudiobookshelfListeningSessionRow[]; total: number }> {
    return this.findPageWhere(eq(audiobookshelfListeningSessions.userId, userId), limit, offset);
  }

  async findPageForBook(
    userId: number,
    bookId: number,
    limit: number,
    offset: number,
  ): Promise<{ rows: AudiobookshelfListeningSessionRow[]; total: number }> {
    return this.findPageWhere(
      and(eq(audiobookshelfListeningSessions.userId, userId), eq(audiobookshelfListeningSessions.bookId, bookId)),
      limit,
      offset,
    );
  }

  async findRecent(userId: number, limit: number): Promise<AudiobookshelfListeningSessionRow[]> {
    return this.db
      .select()
      .from(audiobookshelfListeningSessions)
      .where(eq(audiobookshelfListeningSessions.userId, userId))
      .orderBy(desc(audiobookshelfListeningSessions.updatedAt), desc(audiobookshelfListeningSessions.id))
      .limit(limit);
  }

  /** Grouped SQL aggregates for GET /api/me/listening-stats - never loads per-row data beyond
   * the bounded set of distinct books/days/weekdays the user has listened to. */
  async findStatsAggregate(userId: number, today: string): Promise<StatsAggregate> {
    const whereClause = eq(audiobookshelfListeningSessions.userId, userId);
    const [totalsRows, dayRows, dayOfWeekRows, itemRows, itemMediaMetadataRows] = await Promise.all([
      this.db
        .select({
          totalTime: sql<number>`coalesce(sum(${audiobookshelfListeningSessions.timeListening}), 0)::int`,
          today: sql<number>`coalesce(sum(${audiobookshelfListeningSessions.timeListening}) filter (where ${audiobookshelfListeningSessions.date} = ${today}), 0)::int`,
        })
        .from(audiobookshelfListeningSessions)
        .where(whereClause),
      this.db
        .select({
          date: audiobookshelfListeningSessions.date,
          seconds: sql<number>`coalesce(sum(${audiobookshelfListeningSessions.timeListening}), 0)::int`,
        })
        .from(audiobookshelfListeningSessions)
        .where(whereClause)
        .groupBy(audiobookshelfListeningSessions.date),
      this.db
        .select({
          dayOfWeek: audiobookshelfListeningSessions.dayOfWeek,
          seconds: sql<number>`coalesce(sum(${audiobookshelfListeningSessions.timeListening}), 0)::int`,
        })
        .from(audiobookshelfListeningSessions)
        .where(whereClause)
        .groupBy(audiobookshelfListeningSessions.dayOfWeek),
      this.db
        .select({
          bookId: audiobookshelfListeningSessions.bookId,
          timeListening: sql<number>`coalesce(sum(${audiobookshelfListeningSessions.timeListening}), 0)::int`,
          lastUpdate: sql<Date>`max(${audiobookshelfListeningSessions.updatedAt})`.mapWith(audiobookshelfListeningSessions.updatedAt),
        })
        .from(audiobookshelfListeningSessions)
        .where(whereClause)
        .groupBy(audiobookshelfListeningSessions.bookId),
      this.db
        .selectDistinctOn([audiobookshelfListeningSessions.bookId], {
          bookId: audiobookshelfListeningSessions.bookId,
          mediaMetadata: audiobookshelfListeningSessions.mediaMetadata,
        })
        .from(audiobookshelfListeningSessions)
        .where(whereClause)
        .orderBy(audiobookshelfListeningSessions.bookId, desc(audiobookshelfListeningSessions.updatedAt)),
    ]);

    return {
      totals: { totalTime: totalsRows[0]?.totalTime ?? 0, today: totalsRows[0]?.today ?? 0 },
      days: dayRows,
      dayOfWeek: dayOfWeekRows,
      items: itemRows,
      itemMediaMetadata: itemMediaMetadataRows.map((row) => ({ bookId: row.bookId, mediaMetadata: row.mediaMetadata ?? {} })),
    };
  }

  private async findPageWhere(
    whereClause: ReturnType<typeof and>,
    limit: number,
    offset: number,
  ): Promise<{ rows: AudiobookshelfListeningSessionRow[]; total: number }> {
    const [rows, totalRows] = await Promise.all([
      this.db
        .select()
        .from(audiobookshelfListeningSessions)
        .where(whereClause)
        .orderBy(desc(audiobookshelfListeningSessions.updatedAt), desc(audiobookshelfListeningSessions.id))
        .limit(limit)
        .offset(offset),
      this.db.select({ total: count() }).from(audiobookshelfListeningSessions).where(whereClause),
    ]);
    return { rows, total: totalRows[0]?.total ?? 0 };
  }
}
