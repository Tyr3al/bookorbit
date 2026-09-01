import { sql } from 'drizzle-orm';
import { check, date, index, integer, jsonb, pgTable, real, serial, text, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core';

import { books } from './books';
import { libraries } from './libraries';
import { users } from './auth';

/**
 * Historical record of an Audiobookshelf-compatible listening session, read by
 * GET /api/me/listening-sessions, GET /api/me/item/listening-sessions/:id and
 * GET /api/me/listening-stats. This is intentionally separate from the live playback handshake
 * (play/sync/close), which keeps using a deterministic composite id and never reads this table -
 * see AudiobookshelfPlaybackService. A 'live' row is the single open/refreshed row for a
 * user+book while the deterministic session handle is active; 'local' rows are discrete
 * finished sessions uploaded by an offline client and are never updated after insert.
 *
 * Deliberate tradeoff: because there is exactly one 'live' row per user+book, repeated plays of
 * the same book accumulate into one row (its date/dayOfWeek refresh to the most recent play).
 * Upstream ABS creates a fresh row per play, so its day/weekday attribution splits across plays;
 * BookOrbit merges them. Acceptable for now - a later pass can rotate the live row on close() to
 * match upstream's per-play rows.
 */
export const absListeningSessions = pgTable(
  'abs_listening_sessions',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    bookId: integer('book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),
    libraryId: integer('library_id')
      .notNull()
      .references(() => libraries.id, { onDelete: 'cascade' }),
    source: varchar('source', { length: 10 }).notNull().default('live'),
    displayTitle: varchar('display_title', { length: 1000 }).notNull(),
    displayAuthor: varchar('display_author', { length: 1000 }).notNull().default(''),
    coverPath: text('cover_path'),
    duration: real('duration'),
    playMethod: integer('play_method').notNull().default(0),
    mediaPlayer: varchar('media_player', { length: 100 }).notNull().default('unknown'),
    deviceInfo: jsonb('device_info').$type<Record<string, unknown>>(),
    serverVersion: varchar('server_version', { length: 20 }).notNull(),
    date: date('date', { mode: 'string' }).notNull(),
    dayOfWeek: varchar('day_of_week', { length: 10 }).notNull(),
    timeListening: integer('time_listening').notNull().default(0),
    startTime: real('start_time').notNull().default(0),
    currentTime: real('current_time').notNull().default(0),
    mediaMetadata: jsonb('media_metadata').$type<Record<string, unknown>>().notNull().default({}),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [
    index('abs_listening_sessions_user_updated_idx').on(t.userId, t.updatedAt),
    index('abs_listening_sessions_user_book_updated_idx').on(t.userId, t.bookId, t.updatedAt),
    index('abs_listening_sessions_book_id_idx').on(t.bookId),
    index('abs_listening_sessions_library_id_idx').on(t.libraryId),
    // Guards against duplicate 'live' rows for the same user+book under concurrent play() calls.
    uniqueIndex('abs_listening_sessions_live_uidx')
      .on(t.userId, t.bookId)
      .where(sql`${t.source} = 'live'`),
    check('abs_listening_sessions_source_chk', sql`${t.source} in ('live', 'local')`),
    check('abs_listening_sessions_time_listening_nonnegative_chk', sql`${t.timeListening} >= 0`),
    check('abs_listening_sessions_start_time_nonnegative_chk', sql`${t.startTime} >= 0`),
    check('abs_listening_sessions_current_time_nonnegative_chk', sql`${t.currentTime} >= 0`),
  ],
);

export type AbsListeningSessionRow = typeof absListeningSessions.$inferSelect;
export type NewAbsListeningSession = typeof absListeningSessions.$inferInsert;
