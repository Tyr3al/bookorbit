import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, countDistinct, desc, eq, exists, getTableColumns, inArray, not, sql, type SQL } from 'drizzle-orm';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { ContentFilterRules } from '@bookorbit/types';

import { buildContentFilterClauses } from '../../common/utils/content-filter-sql.utils';
import { parseAbsItemFilter } from '../../common/utils/abs-filter.utils';
import { fromAbsSeriesUuid, fromAbsUuid } from '../../common/utils/abs-id.utils';
import { DB } from '../../db';
import * as schema from '../../db/schema';
import { ABS_AUDIO_FORMATS } from './audiobookshelf.constants';

type Db = NodePgDatabase<typeof schema>;

export type AbsItemSort = 'title' | 'author' | 'addedAt' | 'updatedAt' | 'duration' | 'size' | 'publishedYear';

export interface AbsItemPageQuery {
  limit: number;
  offset: number;
  sort: AbsItemSort;
  desc?: boolean;
  search?: string;
  filter?: string;
}

const AUDIO_FORMAT_WHERE = inArray(schema.bookFiles.format, ABS_AUDIO_FORMATS);
const BOOK_VISIBLE_WHERE = sql`${schema.books.status} <> 'processing'`;

@Injectable()
export class AudiobookshelfRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Libraries opted into the Audiobookshelf API that the user can access. */
  async findOptedInLibraries(userId: number, isSuperuser: boolean): Promise<schema.Library[]> {
    if (isSuperuser) {
      return this.db
        .select()
        .from(schema.libraries)
        .where(eq(schema.libraries.enableAudiobookshelfApi, true))
        .orderBy(asc(schema.libraries.displayOrder), asc(schema.libraries.name));
    }
    const rows = await this.db
      .select({ library: schema.libraries })
      .from(schema.libraries)
      .innerJoin(
        schema.userLibraryAccess,
        and(eq(schema.userLibraryAccess.libraryId, schema.libraries.id), eq(schema.userLibraryAccess.userId, userId)),
      )
      .where(eq(schema.libraries.enableAudiobookshelfApi, true))
      .orderBy(asc(schema.libraries.displayOrder), asc(schema.libraries.name));
    return rows.map((row) => row.library);
  }

  /** True when the library is opted in and the user can access it. */
  async isLibraryExposedForUser(libraryId: number, userId: number, isSuperuser: boolean): Promise<boolean> {
    const base = this.db
      .select({ id: schema.libraries.id })
      .from(schema.libraries)
      .where(and(eq(schema.libraries.id, libraryId), eq(schema.libraries.enableAudiobookshelfApi, true)));
    if (isSuperuser) {
      return (await base.limit(1)).length > 0;
    }
    const rows = await base
      .innerJoin(
        schema.userLibraryAccess,
        and(eq(schema.userLibraryAccess.libraryId, schema.libraries.id), eq(schema.userLibraryAccess.userId, userId)),
      )
      .limit(1);
    return rows.length > 0;
  }

  findFoldersByLibraryIds(libraryIds: number[]): Promise<schema.LibraryFolder[]> {
    if (libraryIds.length === 0) return Promise.resolve([]);
    return this.db.select().from(schema.libraryFolders).where(inArray(schema.libraryFolders.libraryId, libraryIds));
  }

  findLibraryById(libraryId: number): Promise<schema.Library | undefined> {
    return this.db
      .select()
      .from(schema.libraries)
      .where(eq(schema.libraries.id, libraryId))
      .limit(1)
      .then((rows) => rows[0]);
  }

  findBookById(bookId: number): Promise<schema.Book | undefined> {
    return this.db
      .select()
      .from(schema.books)
      .where(eq(schema.books.id, bookId))
      .limit(1)
      .then((rows) => rows[0]);
  }

  findUserById(userId: number): Promise<(schema.User & { isSuperuser: boolean }) | undefined> {
    return this.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1)
      .then((rows) => rows[0]);
  }

  /** Audio book ids in one library, paginated. */
  async findAudioBookIds(libraryId: number, query: AbsItemPageQuery, contentFilters?: ContentFilterRules): Promise<number[]> {
    const orderBy = this.buildItemOrder(query.sort, query.desc ?? false);
    const filterClauses = contentFilters ? buildContentFilterClauses(contentFilters, this.db) : [];
    const rows = await this.db
      .select({ id: schema.books.id })
      .from(schema.books)
      .leftJoin(schema.bookMetadata, eq(schema.bookMetadata.bookId, schema.books.id))
      .where(
        and(
          eq(schema.books.libraryId, libraryId),
          BOOK_VISIBLE_WHERE,
          this.hasAudioFile(),
          ...filterClauses,
          this.buildAbsFilterClause(query.filter),
          query.search ? this.buildTitleSearch(query.search) : undefined,
        ),
      )
      .orderBy(...orderBy)
      .limit(query.limit)
      .offset(query.offset);
    return rows.map((row) => row.id);
  }

  async countAudioBooks(libraryId: number, search?: string, contentFilters?: ContentFilterRules, filter?: string): Promise<number> {
    const filterClauses = contentFilters ? buildContentFilterClauses(contentFilters, this.db) : [];
    const rows = await this.db
      .select({ count: count() })
      .from(schema.books)
      .leftJoin(schema.bookMetadata, eq(schema.bookMetadata.bookId, schema.books.id))
      .where(
        and(
          eq(schema.books.libraryId, libraryId),
          BOOK_VISIBLE_WHERE,
          this.hasAudioFile(),
          ...filterClauses,
          this.buildAbsFilterClause(filter),
          search ? this.buildTitleSearch(search) : undefined,
        ),
      );
    return rows[0]?.count ?? 0;
  }

  /** Total audio-book ids across a set of libraries (used for author/series counts). */
  async findAudioBookIdsByLibraries(libraryIds: number[], contentFilters?: ContentFilterRules): Promise<number[]> {
    if (libraryIds.length === 0) return [];
    const filterClauses = contentFilters ? buildContentFilterClauses(contentFilters, this.db) : [];
    const rows = await this.db
      .select({ id: schema.books.id })
      .from(schema.books)
      .where(and(inArray(schema.books.libraryId, libraryIds), BOOK_VISIBLE_WHERE, this.hasAudioFile(), ...filterClauses));
    return rows.map((row) => row.id);
  }

  findBooksByIds(bookIds: number[]): Promise<schema.Book[]> {
    if (bookIds.length === 0) return Promise.resolve([]);
    return this.db.select().from(schema.books).where(inArray(schema.books.id, bookIds));
  }

  findMetadataByBookIds(bookIds: number[]): Promise<schema.BookMetadata[]> {
    if (bookIds.length === 0) return Promise.resolve([]);
    return this.db.select().from(schema.bookMetadata).where(inArray(schema.bookMetadata.bookId, bookIds));
  }

  findAudioFilesByBookIds(bookIds: number[]): Promise<schema.BookFile[]> {
    if (bookIds.length === 0) return Promise.resolve([]);
    return this.db
      .select()
      .from(schema.bookFiles)
      .where(and(inArray(schema.bookFiles.bookId, bookIds), eq(schema.bookFiles.role, 'content'), AUDIO_FORMAT_WHERE))
      .orderBy(asc(schema.bookFiles.bookId), asc(schema.bookFiles.sortOrder), asc(schema.bookFiles.id));
  }

  findAudioFilesByBookId(bookId: number): Promise<schema.BookFile[]> {
    return this.db
      .select()
      .from(schema.bookFiles)
      .where(and(eq(schema.bookFiles.bookId, bookId), eq(schema.bookFiles.role, 'content'), AUDIO_FORMAT_WHERE))
      .orderBy(asc(schema.bookFiles.sortOrder), asc(schema.bookFiles.id));
  }

  findAuthorsByBookIds(bookIds: number[]): Promise<(schema.Author & { bookId: number })[]> {
    if (bookIds.length === 0) return Promise.resolve([]);
    return this.db
      .select({ ...getTableColumns(schema.authors), bookId: schema.bookAuthors.bookId })
      .from(schema.bookAuthors)
      .innerJoin(schema.authors, eq(schema.authors.id, schema.bookAuthors.authorId))
      .where(inArray(schema.bookAuthors.bookId, bookIds))
      .orderBy(asc(schema.bookAuthors.bookId), asc(schema.bookAuthors.displayOrder));
  }

  findNarratorsByBookIds(bookIds: number[]): Promise<(schema.Narrator & { bookId: number })[]> {
    if (bookIds.length === 0) return Promise.resolve([]);
    return this.db
      .select({ ...getTableColumns(schema.narrators), bookId: schema.bookNarrators.bookId })
      .from(schema.bookNarrators)
      .innerJoin(schema.narrators, eq(schema.narrators.id, schema.bookNarrators.narratorId))
      .where(inArray(schema.bookNarrators.bookId, bookIds))
      .orderBy(asc(schema.bookNarrators.bookId), asc(schema.bookNarrators.displayOrder));
  }

  findSeriesByBookIds(bookIds: number[]): Promise<(schema.BookSeries & { bookId: number; seriesIndex: string | null })[]> {
    if (bookIds.length === 0) return Promise.resolve([]);
    return this.db
      .select({
        ...getTableColumns(schema.bookSeries),
        bookId: schema.bookSeriesMemberships.bookId,
        seriesIndex: schema.bookSeriesMemberships.seriesIndex,
      })
      .from(schema.bookSeriesMemberships)
      .innerJoin(schema.bookSeries, eq(schema.bookSeries.id, schema.bookSeriesMemberships.seriesId))
      .where(inArray(schema.bookSeriesMemberships.bookId, bookIds))
      .orderBy(asc(schema.bookSeriesMemberships.bookId), asc(schema.bookSeriesMemberships.displayOrder));
  }

  findGenresByBookIds(bookIds: number[]): Promise<{ bookId: number; name: string }[]> {
    if (bookIds.length === 0) return Promise.resolve([]);
    return this.db
      .select({ bookId: schema.bookGenres.bookId, name: schema.genres.name })
      .from(schema.bookGenres)
      .innerJoin(schema.genres, eq(schema.genres.id, schema.bookGenres.genreId))
      .where(inArray(schema.bookGenres.bookId, bookIds));
  }

  findProgressByUserId(userId: number): Promise<schema.AudiobookProgress[]> {
    return this.db.select().from(schema.audiobookProgress).where(eq(schema.audiobookProgress.userId, userId));
  }

  /** Progress for audio books visible through the user's exposed ABS libraries. */
  async findProgressForAudiobookshelfUser(user: {
    id: number;
    isSuperuser: boolean;
    contentFilters?: ContentFilterRules;
  }): Promise<schema.AudiobookProgress[]> {
    const filterClauses = !user.isSuperuser && user.contentFilters ? buildContentFilterClauses(user.contentFilters, this.db) : [];
    const accessClause = user.isSuperuser
      ? undefined
      : exists(
          this.db
            .select({ one: sql`1` })
            .from(schema.userLibraryAccess)
            .where(and(eq(schema.userLibraryAccess.userId, user.id), eq(schema.userLibraryAccess.libraryId, schema.books.libraryId))),
        );
    return this.db
      .select({ progress: schema.audiobookProgress })
      .from(schema.audiobookProgress)
      .innerJoin(schema.books, eq(schema.books.id, schema.audiobookProgress.bookId))
      .innerJoin(schema.libraries, eq(schema.libraries.id, schema.books.libraryId))
      .where(
        and(
          eq(schema.audiobookProgress.userId, user.id),
          eq(schema.libraries.enableAudiobookshelfApi, true),
          BOOK_VISIBLE_WHERE,
          this.hasAudioFile(),
          accessClause,
          ...filterClauses,
        ),
      )
      .then((rows) => rows.map((row) => row.progress));
  }

  findProgressByUserIdAndBookIds(userId: number, bookIds: number[]): Promise<schema.AudiobookProgress[]> {
    if (bookIds.length === 0) return Promise.resolve([]);
    return this.db
      .select()
      .from(schema.audiobookProgress)
      .where(and(eq(schema.audiobookProgress.userId, userId), inArray(schema.audiobookProgress.bookId, bookIds)));
  }

  async deleteProgressByUserIdAndBookId(userId: number, bookId: number): Promise<boolean> {
    const deleted = await this.db
      .delete(schema.audiobookProgress)
      .where(and(eq(schema.audiobookProgress.userId, userId), eq(schema.audiobookProgress.bookId, bookId)))
      .returning({ userId: schema.audiobookProgress.userId });
    return deleted.length > 0;
  }

  /**
   * Authors that have audio books in the given libraries, with the count of exposed books.
   * Counts books (not files), so a multi-file audiobook counts once.
   */
  async findAuthorsWithCountsByLibraries(
    libraryIds: number[],
    contentFilters?: ContentFilterRules,
  ): Promise<(schema.Author & { numBooks: number })[]> {
    if (libraryIds.length === 0) return Promise.resolve([]);
    const filterClauses = contentFilters ? buildContentFilterClauses(contentFilters, this.db) : [];
    return this.db
      .select({
        ...getTableColumns(schema.authors),
        numBooks: countDistinct(schema.bookAuthors.bookId),
      })
      .from(schema.bookAuthors)
      .innerJoin(schema.authors, eq(schema.authors.id, schema.bookAuthors.authorId))
      .innerJoin(schema.books, eq(schema.books.id, schema.bookAuthors.bookId))
      .innerJoin(schema.bookFiles, eq(schema.bookFiles.bookId, schema.books.id))
      .where(
        and(
          inArray(schema.books.libraryId, libraryIds),
          BOOK_VISIBLE_WHERE,
          eq(schema.bookFiles.role, 'content'),
          AUDIO_FORMAT_WHERE,
          ...filterClauses,
        ),
      )
      .groupBy(schema.authors.id)
      .orderBy(asc(schema.authors.name));
  }

  /**
   * Narrators that have audio books in the given libraries, with the count of exposed books.
   * Counts books (not files), so a multi-file audiobook counts once.
   */
  async findNarratorsWithCountsByLibraries(
    libraryIds: number[],
    contentFilters?: ContentFilterRules,
  ): Promise<(schema.Narrator & { numBooks: number })[]> {
    if (libraryIds.length === 0) return Promise.resolve([]);
    const filterClauses = contentFilters ? buildContentFilterClauses(contentFilters, this.db) : [];
    return this.db
      .select({
        ...getTableColumns(schema.narrators),
        numBooks: countDistinct(schema.bookNarrators.bookId),
      })
      .from(schema.bookNarrators)
      .innerJoin(schema.narrators, eq(schema.narrators.id, schema.bookNarrators.narratorId))
      .innerJoin(schema.books, eq(schema.books.id, schema.bookNarrators.bookId))
      .innerJoin(schema.bookFiles, eq(schema.bookFiles.bookId, schema.books.id))
      .where(
        and(
          inArray(schema.books.libraryId, libraryIds),
          BOOK_VISIBLE_WHERE,
          eq(schema.bookFiles.role, 'content'),
          AUDIO_FORMAT_WHERE,
          ...filterClauses,
        ),
      )
      .groupBy(schema.narrators.id)
      .orderBy(asc(schema.narrators.name));
  }

  /** Distinct genres/languages/publishers/published-years and the missing-book count across
   * audio books in the given libraries - the aggregates GET /api/libraries/:id/filterdata needs
   * beyond what the authors/series/narrators list queries already cover. */
  async findLibraryFilterAggregates(
    libraryIds: number[],
    contentFilters?: ContentFilterRules,
  ): Promise<{ genres: string[]; languages: string[]; publishers: string[]; publishedYears: number[]; missingCount: number }> {
    if (libraryIds.length === 0) {
      return { genres: [], languages: [], publishers: [], publishedYears: [], missingCount: 0 };
    }
    const filterClauses = contentFilters ? buildContentFilterClauses(contentFilters, this.db) : [];
    const audioBookWhere = and(inArray(schema.books.libraryId, libraryIds), BOOK_VISIBLE_WHERE, this.hasAudioFile(), ...filterClauses);

    const [genreRows, metaRows, missingRows] = await Promise.all([
      this.db
        .selectDistinct({ name: schema.genres.name })
        .from(schema.bookGenres)
        .innerJoin(schema.genres, eq(schema.genres.id, schema.bookGenres.genreId))
        .innerJoin(schema.books, eq(schema.books.id, schema.bookGenres.bookId))
        .where(audioBookWhere),
      this.db
        .selectDistinct({
          language: schema.bookMetadata.language,
          publisher: schema.bookMetadata.publisher,
          publishedYear: schema.bookMetadata.publishedYear,
        })
        .from(schema.bookMetadata)
        .innerJoin(schema.books, eq(schema.books.id, schema.bookMetadata.bookId))
        .where(audioBookWhere),
      this.db
        .select({ count: count() })
        .from(schema.books)
        .where(and(inArray(schema.books.libraryId, libraryIds), eq(schema.books.status, 'missing'))),
    ]);

    return {
      genres: genreRows.map((row) => row.name),
      languages: [...new Set(metaRows.map((row) => row.language).filter((value): value is string => value != null))],
      publishers: [...new Set(metaRows.map((row) => row.publisher).filter((value): value is string => value != null))],
      publishedYears: [...new Set(metaRows.map((row) => row.publishedYear).filter((value): value is number => value != null))],
      missingCount: missingRows[0]?.count ?? 0,
    };
  }

  /** Authors of one specific book. */
  findAuthorIdsByBookIds(bookIds: number[]): Promise<{ bookId: number; authorId: number }[]> {
    if (bookIds.length === 0) return Promise.resolve([]);
    return this.db
      .select({ bookId: schema.bookAuthors.bookId, authorId: schema.bookAuthors.authorId })
      .from(schema.bookAuthors)
      .where(inArray(schema.bookAuthors.bookId, bookIds));
  }

  findAuthorsByIds(authorIds: number[]): Promise<schema.Author[]> {
    if (authorIds.length === 0) return Promise.resolve([]);
    return this.db.select().from(schema.authors).where(inArray(schema.authors.id, authorIds));
  }

  /** True when a book has at least one audio content file. */
  private hasAudioFile(): SQL {
    return exists(
      this.db
        .select({ id: schema.bookFiles.id })
        .from(schema.bookFiles)
        .where(and(eq(schema.bookFiles.bookId, schema.books.id), eq(schema.bookFiles.role, 'content'), AUDIO_FORMAT_WHERE)),
    );
  }

  /**
   * Series that have audio books in the given libraries.
   */
  async findSeriesByLibraries(libraryIds: number[], contentFilters?: ContentFilterRules): Promise<schema.BookSeries[]> {
    if (libraryIds.length === 0) return Promise.resolve([]);
    const filterClauses = contentFilters ? buildContentFilterClauses(contentFilters, this.db) : [];
    const rows = await this.db
      .selectDistinctOn([schema.bookSeries.id], { ...getTableColumns(schema.bookSeries) })
      .from(schema.bookSeries)
      .innerJoin(schema.bookSeriesMemberships, eq(schema.bookSeriesMemberships.seriesId, schema.bookSeries.id))
      .innerJoin(schema.books, eq(schema.books.id, schema.bookSeriesMemberships.bookId))
      .innerJoin(schema.bookFiles, eq(schema.bookFiles.bookId, schema.books.id))
      .where(
        and(
          inArray(schema.books.libraryId, libraryIds),
          BOOK_VISIBLE_WHERE,
          eq(schema.bookFiles.role, 'content'),
          AUDIO_FORMAT_WHERE,
          ...filterClauses,
        ),
      )
      .orderBy(asc(schema.bookSeries.id), asc(schema.bookSeries.name));
    return rows;
  }

  findSeriesById(seriesId: number): Promise<schema.BookSeries | undefined> {
    return this.db
      .select()
      .from(schema.bookSeries)
      .where(eq(schema.bookSeries.id, seriesId))
      .limit(1)
      .then((rows) => rows[0]);
  }

  async findAccessibleSeriesBook(
    seriesId: number,
    libraryIds: number[],
    contentFilters?: ContentFilterRules,
  ): Promise<{ bookId: number; libraryId: number } | undefined> {
    if (libraryIds.length === 0) return undefined;
    const filterClauses = contentFilters ? buildContentFilterClauses(contentFilters, this.db) : [];
    const [row] = await this.db
      .select({ bookId: schema.books.id, libraryId: schema.books.libraryId })
      .from(schema.bookSeriesMemberships)
      .innerJoin(schema.books, eq(schema.books.id, schema.bookSeriesMemberships.bookId))
      .where(
        and(
          eq(schema.bookSeriesMemberships.seriesId, seriesId),
          inArray(schema.books.libraryId, libraryIds),
          BOOK_VISIBLE_WHERE,
          this.hasAudioFile(),
          ...filterClauses,
        ),
      )
      .orderBy(asc(schema.books.id))
      .limit(1);
    return row;
  }

  findSeriesMembershipBookIds(seriesIds: number[]): Promise<{ seriesId: number; bookId: number }[]> {
    if (seriesIds.length === 0) return Promise.resolve([]);
    return this.db
      .select({ seriesId: schema.bookSeriesMemberships.seriesId, bookId: schema.bookSeriesMemberships.bookId })
      .from(schema.bookSeriesMemberships)
      .where(inArray(schema.bookSeriesMemberships.seriesId, seriesIds));
  }

  findCollectionsByUserId(userId: number): Promise<schema.Collection[]> {
    return this.db
      .select()
      .from(schema.collections)
      .where(eq(schema.collections.userId, userId))
      .orderBy(asc(schema.collections.displayOrder), asc(schema.collections.name));
  }

  async findCollectionsByUserIdAndLibrary(
    userId: number,
    libraryId: number,
    contentFilters: ContentFilterRules | undefined,
    limit: number,
    offset: number,
  ): Promise<schema.Collection[]> {
    const filterClauses = contentFilters ? buildContentFilterClauses(contentFilters, this.db) : [];
    return this.db
      .select({ collection: schema.collections })
      .from(schema.collections)
      .where(
        and(
          eq(schema.collections.userId, userId),
          exists(
            this.db
              .select({ id: schema.collectionBooks.collectionId })
              .from(schema.collectionBooks)
              .innerJoin(schema.books, eq(schema.books.id, schema.collectionBooks.bookId))
              .where(
                and(
                  eq(schema.collectionBooks.collectionId, schema.collections.id),
                  eq(schema.books.libraryId, libraryId),
                  BOOK_VISIBLE_WHERE,
                  this.hasAudioFile(),
                  ...filterClauses,
                ),
              ),
          ),
        ),
      )
      .orderBy(asc(schema.collections.displayOrder), asc(schema.collections.name))
      .limit(limit)
      .offset(offset)
      .then((rows) => rows.map((row) => row.collection));
  }

  async countCollectionsByUserIdAndLibrary(userId: number, libraryId: number, contentFilters?: ContentFilterRules): Promise<number> {
    const filterClauses = contentFilters ? buildContentFilterClauses(contentFilters, this.db) : [];
    const [row] = await this.db
      .select({ count: count() })
      .from(schema.collections)
      .where(
        and(
          eq(schema.collections.userId, userId),
          exists(
            this.db
              .select({ id: schema.collectionBooks.collectionId })
              .from(schema.collectionBooks)
              .innerJoin(schema.books, eq(schema.books.id, schema.collectionBooks.bookId))
              .where(
                and(
                  eq(schema.collectionBooks.collectionId, schema.collections.id),
                  eq(schema.books.libraryId, libraryId),
                  BOOK_VISIBLE_WHERE,
                  this.hasAudioFile(),
                  ...filterClauses,
                ),
              ),
          ),
        ),
      );
    return Number(row?.count ?? 0);
  }

  findCollectionById(id: number): Promise<schema.Collection | undefined> {
    return this.db
      .select()
      .from(schema.collections)
      .where(eq(schema.collections.id, id))
      .limit(1)
      .then((rows) => rows[0]);
  }

  findCollectionBookIdsByCollectionIds(collectionIds: number[]): Promise<{ collectionId: number; bookId: number }[]> {
    if (collectionIds.length === 0) return Promise.resolve([]);
    return this.db
      .select({ collectionId: schema.collectionBooks.collectionId, bookId: schema.collectionBooks.bookId })
      .from(schema.collectionBooks)
      .where(inArray(schema.collectionBooks.collectionId, collectionIds))
      .orderBy(asc(schema.collectionBooks.collectionId), asc(schema.collectionBooks.position));
  }

  findCollectionBookIdsByCollectionIdsAndLibraries(
    collectionIds: number[],
    libraryIds: number[],
    contentFilters?: ContentFilterRules,
  ): Promise<{ collectionId: number; bookId: number }[]> {
    if (collectionIds.length === 0 || libraryIds.length === 0) return Promise.resolve([]);
    const filterClauses = contentFilters ? buildContentFilterClauses(contentFilters, this.db) : [];
    return this.db
      .select({ collectionId: schema.collectionBooks.collectionId, bookId: schema.collectionBooks.bookId })
      .from(schema.collectionBooks)
      .innerJoin(schema.books, eq(schema.books.id, schema.collectionBooks.bookId))
      .where(
        and(
          inArray(schema.collectionBooks.collectionId, collectionIds),
          inArray(schema.books.libraryId, libraryIds),
          BOOK_VISIBLE_WHERE,
          this.hasAudioFile(),
          ...filterClauses,
        ),
      )
      .orderBy(asc(schema.collectionBooks.collectionId), asc(schema.collectionBooks.position));
  }

  /** Translates real ABS's `filter=<category>.<value>` item-list filter into a SQL clause
   * scoped to `schema.books.id`. Unrecognized categories/values fall back to no filtering
   * (matches ABS's tolerant behavior better than hiding everything). */
  private buildAbsFilterClause(filter?: string): SQL | undefined {
    const parsed = parseAbsItemFilter(filter);
    if (!parsed) return undefined;
    const { category, value } = parsed;

    switch (category) {
      case 'authors': {
        const authorId = fromAbsUuid(value);
        if (authorId === null) return sql`false`;
        return exists(
          this.db
            .select({ id: schema.bookAuthors.bookId })
            .from(schema.bookAuthors)
            .where(and(eq(schema.bookAuthors.bookId, schema.books.id), eq(schema.bookAuthors.authorId, authorId))),
        );
      }
      case 'series': {
        const seriesId = fromAbsSeriesUuid(value);
        if (seriesId === null) return sql`false`;
        return exists(
          this.db
            .select({ id: schema.bookSeriesMemberships.bookId })
            .from(schema.bookSeriesMemberships)
            .where(and(eq(schema.bookSeriesMemberships.bookId, schema.books.id), eq(schema.bookSeriesMemberships.seriesId, seriesId))),
        );
      }
      case 'narrators':
        return exists(
          this.db
            .select({ id: schema.bookNarrators.bookId })
            .from(schema.bookNarrators)
            .innerJoin(schema.narrators, eq(schema.narrators.id, schema.bookNarrators.narratorId))
            .where(and(eq(schema.bookNarrators.bookId, schema.books.id), eq(schema.narrators.name, value))),
        );
      case 'genres':
        return exists(
          this.db
            .select({ id: schema.bookGenres.bookId })
            .from(schema.bookGenres)
            .innerJoin(schema.genres, eq(schema.genres.id, schema.bookGenres.genreId))
            .where(and(eq(schema.bookGenres.bookId, schema.books.id), eq(schema.genres.name, value))),
        );
      case 'publishers':
        return eq(schema.bookMetadata.publisher, value);
      case 'languages':
        return eq(schema.bookMetadata.language, value);
      case 'missing':
        return this.buildMissingFilterClause(value);
      default:
        return undefined;
    }
  }

  private buildMissingFilterClause(field: string): SQL | undefined {
    switch (field) {
      case 'authors':
        return not(
          exists(this.db.select({ id: schema.bookAuthors.bookId }).from(schema.bookAuthors).where(eq(schema.bookAuthors.bookId, schema.books.id))),
        );
      case 'series':
        return not(
          exists(
            this.db
              .select({ id: schema.bookSeriesMemberships.bookId })
              .from(schema.bookSeriesMemberships)
              .where(eq(schema.bookSeriesMemberships.bookId, schema.books.id)),
          ),
        );
      case 'genres':
        return not(
          exists(this.db.select({ id: schema.bookGenres.bookId }).from(schema.bookGenres).where(eq(schema.bookGenres.bookId, schema.books.id))),
        );
      case 'narrators':
        return not(
          exists(
            this.db.select({ id: schema.bookNarrators.bookId }).from(schema.bookNarrators).where(eq(schema.bookNarrators.bookId, schema.books.id)),
          ),
        );
      case 'isbn':
        return sql`(${schema.bookMetadata.isbn13} is null and ${schema.bookMetadata.isbn10} is null)`;
      case 'subtitle':
        return sql`${schema.bookMetadata.subtitle} is null`;
      case 'description':
        return sql`${schema.bookMetadata.description} is null`;
      case 'publisher':
        return sql`${schema.bookMetadata.publisher} is null`;
      case 'language':
        return sql`${schema.bookMetadata.language} is null`;
      default:
        return undefined;
    }
  }

  private buildTitleSearch(search: string): SQL {
    const pattern = `%${search.trim().toLowerCase()}%`;
    return sql`lower(coalesce(${schema.bookMetadata.title}, '')) like ${pattern}`;
  }

  private buildItemOrder(sort: AbsItemSort, descending = false): SQL[] {
    const titleOrder = descending
      ? desc(sql`lower(coalesce(${schema.bookMetadata.title}, ''))`)
      : asc(sql`lower(coalesce(${schema.bookMetadata.title}, ''))`);
    switch (sort) {
      case 'author': {
        const authorOrder = descending
          ? desc(sql`${schema.books.primaryAuthorSortName} collate "C" nulls last`)
          : asc(sql`${schema.books.primaryAuthorSortName} collate "C" nulls last`);
        return [authorOrder, titleOrder];
      }
      case 'addedAt':
        return descending ? [desc(schema.books.addedAt), desc(schema.books.id)] : [asc(schema.books.addedAt), asc(schema.books.id)];
      case 'updatedAt':
        return descending ? [desc(schema.books.updatedAt), desc(schema.books.id)] : [asc(schema.books.updatedAt), asc(schema.books.id)];
      case 'duration': {
        const durationOrder = descending
          ? desc(sql`coalesce(${schema.bookMetadata.durationSeconds}, 0)`)
          : asc(sql`coalesce(${schema.bookMetadata.durationSeconds}, 0)`);
        return [durationOrder, asc(schema.books.id)];
      }
      case 'size': {
        const sizeExpression = sql`coalesce((select sum(${schema.bookFiles.sizeBytes}) from ${schema.bookFiles} where ${schema.bookFiles.bookId} = ${schema.books.id} and ${schema.bookFiles.role} = 'content'), 0)`;
        return descending ? [desc(sizeExpression), desc(schema.books.id)] : [asc(sizeExpression), asc(schema.books.id)];
      }
      case 'publishedYear': {
        const yearExpression = sql`coalesce(${schema.bookMetadata.publishedYear}, 0)`;
        return descending ? [desc(yearExpression), desc(schema.books.id)] : [asc(yearExpression), asc(schema.books.id)];
      }
      case 'title':
      default:
        return [titleOrder, asc(schema.books.id)];
    }
  }
}
