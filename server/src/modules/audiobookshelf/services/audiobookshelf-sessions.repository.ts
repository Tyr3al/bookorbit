import { Inject, Injectable } from '@nestjs/common';
import { and, count, desc, eq, sql } from 'drizzle-orm';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { DB } from '../../../db';
import * as schema from '../../../db/schema';
import type { AbsListeningSessionRow, NewAbsListeningSession } from '../../../db/schema';

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

const { absListeningSessions } = schema;

@Injectable()
export class AudiobookshelfSessionsRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Opens the single 'live' row for this user+book if none exists yet, otherwise refreshes its
   * snapshot fields in place. The accumulated timeListening total is left untouched here - only
   * accumulateLiveSession() advances it. Atomic via the partial unique index on (userId, bookId)
   * where source='live', so concurrent play() calls for the same book cannot double-insert. */
  async upsertLiveSession(userId: number, input: UpsertLiveSessionInput): Promise<AbsListeningSessionRow> {
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
      .insert(absListeningSessions)
      .values({ userId, bookId: input.bookId, source: 'live', timeListening: 0, startedAt: input.now, ...snapshot })
      .onConflictDoUpdate({
        target: [absListeningSessions.userId, absListeningSessions.bookId],
        targetWhere: sql`${absListeningSessions.source} = 'live'`,
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
      setValues.timeListening = sql`${absListeningSessions.timeListening} + ${Math.round(input.timeListeningDelta)}`;
    }
    if (input.currentTime !== undefined) setValues.currentTime = input.currentTime;

    await this.db
      .update(absListeningSessions)
      .set(setValues)
      .where(and(eq(absListeningSessions.userId, userId), eq(absListeningSessions.bookId, bookId), eq(absListeningSessions.source, 'live')));
  }

  /** Bulk-inserts discrete offline sessions uploaded by a client - one write for the whole
   * batch, never one write per entry. */
  async insertLocalSessions(rows: NewAbsListeningSession[]): Promise<void> {
    if (rows.length === 0) return;
    await this.db.insert(absListeningSessions).values(rows);
  }

  async findPage(userId: number, limit: number, offset: number): Promise<{ rows: AbsListeningSessionRow[]; total: number }> {
    return this.findPageWhere(eq(absListeningSessions.userId, userId), limit, offset);
  }

  async findPageForBook(userId: number, bookId: number, limit: number, offset: number): Promise<{ rows: AbsListeningSessionRow[]; total: number }> {
    return this.findPageWhere(and(eq(absListeningSessions.userId, userId), eq(absListeningSessions.bookId, bookId)), limit, offset);
  }

  async findRecent(userId: number, limit: number): Promise<AbsListeningSessionRow[]> {
    return this.db
      .select()
      .from(absListeningSessions)
      .where(eq(absListeningSessions.userId, userId))
      .orderBy(desc(absListeningSessions.updatedAt), desc(absListeningSessions.id))
      .limit(limit);
  }

  /** Grouped SQL aggregates for GET /api/me/listening-stats - never loads per-row data beyond
   * the bounded set of distinct books/days/weekdays the user has listened to. */
  async findStatsAggregate(userId: number, today: string): Promise<StatsAggregate> {
    const whereClause = eq(absListeningSessions.userId, userId);
    const [totalsRows, dayRows, dayOfWeekRows, itemRows, itemMediaMetadataRows] = await Promise.all([
      this.db
        .select({
          totalTime: sql<number>`coalesce(sum(${absListeningSessions.timeListening}), 0)::int`,
          today: sql<number>`coalesce(sum(${absListeningSessions.timeListening}) filter (where ${absListeningSessions.date} = ${today}), 0)::int`,
        })
        .from(absListeningSessions)
        .where(whereClause),
      this.db
        .select({ date: absListeningSessions.date, seconds: sql<number>`coalesce(sum(${absListeningSessions.timeListening}), 0)::int` })
        .from(absListeningSessions)
        .where(whereClause)
        .groupBy(absListeningSessions.date),
      this.db
        .select({ dayOfWeek: absListeningSessions.dayOfWeek, seconds: sql<number>`coalesce(sum(${absListeningSessions.timeListening}), 0)::int` })
        .from(absListeningSessions)
        .where(whereClause)
        .groupBy(absListeningSessions.dayOfWeek),
      this.db
        .select({
          bookId: absListeningSessions.bookId,
          timeListening: sql<number>`coalesce(sum(${absListeningSessions.timeListening}), 0)::int`,
          lastUpdate: sql<Date>`max(${absListeningSessions.updatedAt})`.mapWith(absListeningSessions.updatedAt),
        })
        .from(absListeningSessions)
        .where(whereClause)
        .groupBy(absListeningSessions.bookId),
      this.db
        .selectDistinctOn([absListeningSessions.bookId], { bookId: absListeningSessions.bookId, mediaMetadata: absListeningSessions.mediaMetadata })
        .from(absListeningSessions)
        .where(whereClause)
        .orderBy(absListeningSessions.bookId, desc(absListeningSessions.updatedAt)),
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
  ): Promise<{ rows: AbsListeningSessionRow[]; total: number }> {
    const [rows, totalRows] = await Promise.all([
      this.db
        .select()
        .from(absListeningSessions)
        .where(whereClause)
        .orderBy(desc(absListeningSessions.updatedAt), desc(absListeningSessions.id))
        .limit(limit)
        .offset(offset),
      this.db.select({ total: count() }).from(absListeningSessions).where(whereClause),
    ]);
    return { rows, total: totalRows[0]?.total ?? 0 };
  }
}
