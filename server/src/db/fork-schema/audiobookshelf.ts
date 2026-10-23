import { integer, pgTable, timestamp } from 'drizzle-orm/pg-core';

import { libraries } from '../schema/libraries';

/** Libraries exposed through the Audiobookshelf-compatible API. A row means exposed. */
export const audiobookshelfExposedLibraries = pgTable('abs_exposed_libraries', {
  libraryId: integer('library_id')
    .primaryKey()
    .references(() => libraries.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
