import { sql, type AnyColumn, type SQL } from 'drizzle-orm';

import { audiobookshelfExposedLibraries } from '../../db/fork-schema';

/** True when the library is exposed through the Audiobookshelf-compatible API. */
export function isAudiobookshelfExposedLibrary(libraryId: AnyColumn): SQL {
  return sql`exists (select 1 from ${audiobookshelfExposedLibraries} where ${audiobookshelfExposedLibraries.libraryId} = ${libraryId})`;
}
