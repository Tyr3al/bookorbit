import { Inject, Injectable } from '@nestjs/common';
import { and, count, desc, eq, exists, sql, type SQL } from 'drizzle-orm';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { ContentFilterRules, ReadingSessionSource } from '@bookorbit/types';

import { buildContentFilterClauses } from '../../../common/utils/content-filter-sql.utils';
import { DB } from '../../../db';
import * as schema from '../../../db/schema';
import { isAudiobookshelfExposedLibrary } from '../audiobookshelf-exposure.sql';

type Db = NodePgDatabase<typeof schema>;

const { readingSessions, books, userLibraryAccess } = schema;

export interface AudiobookshelfSessionsScope {
  id: number;
  isSuperuser: boolean;
  contentFilters?: ContentFilterRules;
}

export interface ListeningSessionRow {
  id: number;
  bookId: number;
  libraryId: number;
  source: ReadingSessionSource | null;
  sourceDeviceKey: string | null;
  startedAt: Date;
  endedAt: Date;
  durationSeconds: number;
  progressDelta: number | null;
  endProgress: number | null;
}

export interface StatsAggregate {
  totals: { totalTime: number; today: number };
  days: { date: string; seconds: number }[];
  dayOfWeek: { dayOfWeek: string; seconds: number }[];
  items: { bookId: number; timeListening: number; lastUpdate: Date }[];
}

const LISTENING_SESSION_COLUMNS = {
  id: readingSessions.id,
  bookId: readingSessions.bookId,
  libraryId: books.libraryId,
  source: readingSessions.source,
  sourceDeviceKey: readingSessions.sourceDeviceKey,
  startedAt: readingSessions.startedAt,
  endedAt: readingSessions.endedAt,
  durationSeconds: readingSessions.durationSeconds,
  progressDelta: readingSessions.progressDelta,
  endProgress: readingSessions.endProgress,
};

/**
 * Reads the user's audiobook listening history for the ABS listening-session and stats routes.
 * The history lives in BookOrbit's own reading_sessions (sessionType 'listen'), so listening from
 * the web player and native apps shows up in ABS clients and ABS listening shows up in BookOrbit.
 * Scoped like every other ABS read: ABS-exposed libraries the user can access, visible books, and
 * the user's content filters.
 */
@Injectable()
export class AudiobookshelfSessionsRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async findPage(
    user: AudiobookshelfSessionsScope,
    limit: number,
    offset: number,
    bookId?: number,
  ): Promise<{ rows: ListeningSessionRow[]; total: number }> {
    const where = this.scopeWhere(user, bookId);
    const [rows, totalRows] = await Promise.all([
      this.db
        .select(LISTENING_SESSION_COLUMNS)
        .from(readingSessions)
        .innerJoin(books, eq(books.id, readingSessions.bookId))
        .where(where)
        .orderBy(desc(readingSessions.endedAt), desc(readingSessions.id))
        .limit(limit)
        .offset(offset),
      this.db.select({ total: count() }).from(readingSessions).innerJoin(books, eq(books.id, readingSessions.bookId)).where(where),
    ]);
    return { rows, total: totalRows[0]?.total ?? 0 };
  }

  /** Grouped SQL aggregates only; per-row data is bounded to the distinct books/days/weekdays the
   * user has listened on. Days and weekdays are bucketed in the user's time zone. The local-date
   * expressions group by ordinal because the bound time zone would otherwise be a different
   * parameter in the select list and the GROUP BY, which Postgres rejects. */
  async findStatsAggregate(user: AudiobookshelfSessionsScope, timeZone: string, today: string): Promise<StatsAggregate> {
    const where = this.scopeWhere(user);
    const localDate = sql<string>`to_char(${readingSessions.startedAt} at time zone ${timeZone}, 'YYYY-MM-DD')`;
    const localWeekday = sql<string>`to_char(${readingSessions.startedAt} at time zone ${timeZone}, 'FMDay')`;
    const seconds = sql<number>`coalesce(sum(${readingSessions.durationSeconds}), 0)::int`;

    const [totalsRows, dayRows, dayOfWeekRows, itemRows] = await Promise.all([
      this.db
        .select({
          totalTime: seconds,
          today: sql<number>`coalesce(sum(${readingSessions.durationSeconds}) filter (where ${localDate} = ${today}), 0)::int`,
        })
        .from(readingSessions)
        .innerJoin(books, eq(books.id, readingSessions.bookId))
        .where(where),
      this.db
        .select({ date: localDate, seconds })
        .from(readingSessions)
        .innerJoin(books, eq(books.id, readingSessions.bookId))
        .where(where)
        .groupBy(sql`1`),
      this.db
        .select({ dayOfWeek: localWeekday, seconds })
        .from(readingSessions)
        .innerJoin(books, eq(books.id, readingSessions.bookId))
        .where(where)
        .groupBy(sql`1`),
      this.db
        .select({
          bookId: readingSessions.bookId,
          timeListening: seconds,
          lastUpdate: sql<Date>`max(${readingSessions.endedAt})`.mapWith(readingSessions.endedAt),
        })
        .from(readingSessions)
        .innerJoin(books, eq(books.id, readingSessions.bookId))
        .where(where)
        .groupBy(readingSessions.bookId),
    ]);

    return {
      totals: { totalTime: totalsRows[0]?.totalTime ?? 0, today: totalsRows[0]?.today ?? 0 },
      days: dayRows,
      dayOfWeek: dayOfWeekRows,
      items: itemRows,
    };
  }

  private scopeWhere(user: AudiobookshelfSessionsScope, bookId?: number): SQL | undefined {
    const filterClauses = !user.isSuperuser && user.contentFilters ? buildContentFilterClauses(user.contentFilters, this.db) : [];
    const accessClause = user.isSuperuser
      ? undefined
      : exists(
          this.db
            .select({ one: sql`1` })
            .from(userLibraryAccess)
            .where(and(eq(userLibraryAccess.userId, user.id), eq(userLibraryAccess.libraryId, books.libraryId))),
        );
    return and(
      eq(readingSessions.userId, user.id),
      eq(readingSessions.sessionType, 'listen'),
      bookId === undefined ? undefined : eq(readingSessions.bookId, bookId),
      isAudiobookshelfExposedLibrary(books.libraryId),
      sql`${books.status} <> 'processing'`,
      accessClause,
      ...filterClauses,
    );
  }
}
