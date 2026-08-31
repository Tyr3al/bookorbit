import { describe, expect, it } from 'vitest';

import { LibraryItemMapperService } from './library-item-mapper.service';
import type { MapLibraryItemInput, MapperAuthorRow, MapperNarratorRow, MapperSeriesRow } from './library-item-mapper.service';
import type { Book, BookFile, BookMetadata } from '../../db/schema';
import { toAbsSeriesUuid, toAbsUuid } from '../../../common/utils/abs-id.utils';

const mapper = new LibraryItemMapperService();

function book(overrides: Partial<Book> = {}): Book {
  return {
    id: 7,
    libraryId: 2,
    libraryFolderId: 5,
    primaryFileId: null,
    primaryAuthorSortName: null,
    folderPath: '/books/A Collection/Book One',
    status: 'present',
    addedAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-02T00:00:00Z'),
    ...overrides,
  };
}

function audioFile(overrides: Partial<BookFile> = {}): BookFile {
  return {
    id: 11,
    bookId: 7,
    libraryFolderId: 5,
    absolutePath: '/books/A Collection/Book One/track-1.mp3',
    relPath: 'A Collection/Book One/track-1.mp3',
    ino: 12345n,
    sizeBytes: 1000,
    mtime: new Date('2024-01-01T00:00:00Z'),
    fileHash: null,
    format: 'mp3',
    role: 'content',
    sortOrder: 0,
    durationSeconds: 60,
    isFixedLayout: null,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}

function metadata(overrides: Partial<BookMetadata> = {}): BookMetadata {
  return {
    bookId: 7,
    title: 'Book One',
    subtitle: 'The Subtitle',
    description: 'A description',
    isbn10: null,
    isbn13: '9781234567897',
    publisher: 'ACME',
    publishedDate: '2024-05-01',
    publishedYear: 2024,
    language: 'en',
    pageCount: null,
    seriesId: 3,
    seriesName: 'A Collection',
    seriesIndex: '1',
    rating: null,
    coverSource: null,
    googleBooksId: null,
    goodreadsId: null,
    amazonId: null,
    hardcoverId: null,
    hardcoverEditionId: null,
    openLibraryId: null,
    itunesId: null,
    koboId: null,
    metadataScore: null,
    lastMetadataFetchAt: null,
    embedding: [],
    lastWrittenAt: null,
    durationSeconds: 120,
    abridged: false,
    audibleId: null,
    librofmId: null,
    comicvineId: null,
    ranobedbId: null,
    lubimyczytacId: null,
    aladinId: null,
    chapters: null,
    lockedFields: [],
    coverUpdatedAt: null,
    updatedAt: new Date('2024-01-02T00:00:00Z'),
    ...overrides,
  };
}

function author(overrides: Partial<MapperAuthorRow> = {}): MapperAuthorRow {
  return {
    id: 1,
    bookId: 7,
    name: 'Jane Doe',
    sortName: 'Doe, Jane',
    description: null,
    hasPhoto: false,
    birthDate: null,
    birthYear: null,
    deathDate: null,
    deathYear: null,
    website: null,
    genres: null,
    influences: null,
    metadataProvider: null,
    metadataProviderId: null,
    lastEnrichedAt: null,
    ...overrides,
  };
}

function narrator(overrides: Partial<MapperNarratorRow> = {}): MapperNarratorRow {
  return { id: 2, bookId: 7, name: 'Narrator One', sortName: null, createdAt: new Date('2024-01-01T00:00:00Z'), ...overrides };
}

function series(overrides: Partial<MapperSeriesRow> = {}): MapperSeriesRow {
  return {
    id: 3,
    bookId: 7,
    seriesIndex: '1',
    name: 'A Collection',
    normalizedName: 'a collection',
    expectedBookCount: null,
    expectedBookCountSource: null,
    expectedBookCountUpdatedAt: null,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}

function input(overrides: Partial<MapLibraryItemInput> = {}): MapLibraryItemInput {
  return {
    book: book(),
    metadata: metadata(),
    audioFiles: [
      audioFile(),
      audioFile({
        id: 12,
        absolutePath: '/books/A Collection/Book One/track-2.mp3',
        relPath: 'A Collection/Book One/track-2.mp3',
        sortOrder: 1,
        durationSeconds: 60,
        sizeBytes: 2000,
      }),
    ],
    authors: [author()],
    narrators: [narrator()],
    series: [series()],
    genres: [{ bookId: 7, name: 'Fantasy' }],
    ...overrides,
  };
}

describe('LibraryItemMapperService', () => {
  it('maps identity, timestamps, and file-level fields', () => {
    const item = mapper.toLibraryItem(input());

    expect(item.id).toBe(toAbsUuid(7));
    expect(item.libraryId).toBe(toAbsUuid(2));
    expect(item.folderId).toBe(toAbsUuid(5));
    expect(item.mediaType).toBe('book');
    expect(item.path).toBe('/books/A Collection/Book One');
    expect(item.isFile).toBe(false);
    expect(item.isMissing).toBe(false);
    expect(item.size).toBe(3000);
    expect(item.addedAt).toBe(new Date('2024-01-01T00:00:00Z').getTime());
    expect(item.updatedAt).toBe(new Date('2024-01-02T00:00:00Z').getTime());
  });

  it('marks single-file books as isFile', () => {
    const item = mapper.toLibraryItem(input({ audioFiles: [audioFile()] }));
    expect(item.isFile).toBe(true);
  });

  it('exposes missing books via isMissing', () => {
    const item = mapper.toLibraryItem(input({ book: book({ status: 'missing' }) }));
    expect(item.isMissing).toBe(true);
  });

  it('maps tracks with cumulative start offsets and content urls', () => {
    const item = mapper.toLibraryItem(input());
    const tracks = item.media.tracks;

    expect(tracks).toHaveLength(2);
    expect(tracks[0]).toMatchObject({
      index: 0,
      startOffset: 0,
      contentUrl: `/abs/api/items/${toAbsUuid(7)}/file/${toAbsUuid(11)}`,
      mimeType: 'audio/mpeg',
    });
    expect(tracks[1]).toMatchObject({ index: 1, startOffset: 60, contentUrl: `/abs/api/items/${toAbsUuid(7)}/file/${toAbsUuid(12)}` });
  });

  it('maps audioFiles with metadata and per-file duration', () => {
    const item = mapper.toLibraryItem(input());
    const files = item.media.audioFiles;

    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({
      index: 0,
      duration: 60,
      mimeType: 'audio/mpeg',
      metadata: { filename: 'track-1.mp3', ext: 'mp3', size: 1000, relPath: 'A Collection/Book One/track-1.mp3' },
    });
    expect(item.libraryFiles[0].ino).toBe('12345');
  });

  it('maps book metadata, authors, narrators, series, and genres', () => {
    const media = mapper.toLibraryItem(input()).media;

    expect(media.metadata.title).toBe('Book One');
    expect(media.metadata.subtitle).toBe('The Subtitle');
    expect(media.metadata.publisher).toBe('ACME');
    expect(media.metadata.publishedYear).toBe('2024');
    expect(media.metadata.isbn).toBe('9781234567897');
    expect(media.metadata.authors).toEqual([{ id: toAbsUuid(1), name: 'Jane Doe' }]);
    expect(media.metadata.authorName).toBe('Jane Doe');
    expect(media.metadata.authorNameLF).toBe('Doe, Jane');
    expect(media.metadata.narrators).toEqual(['Narrator One']);
    expect(media.metadata.narratorName).toBe('Narrator One');
    expect(media.metadata.series).toEqual([{ id: toAbsSeriesUuid(3), name: 'A Collection', sequence: '1' }]);
    expect(media.metadata.seriesName).toBe('A Collection #1');
    expect(media.metadata.genres).toEqual(['Fantasy']);
    expect(media.duration).toBe(120);
  });

  it('maps chapters from BookOrbit startMs lists into ABS seconds with end boundaries', () => {
    const chapters = [
      { title: 'Chapter 1', startMs: 0 },
      { title: 'Chapter 2', startMs: 30_000 },
    ];
    const media = mapper.toLibraryItem(input({ metadata: metadata({ chapters }) })).media;

    expect(media.chapters).toEqual([
      { id: 0, start: 0, end: 30, title: 'Chapter 1' },
      { id: 1, start: 30, end: 120, title: 'Chapter 2' },
    ]);
  });

  it('uses audio tracks as chapters when none are stored', () => {
    const media = mapper.toLibraryItem(input({ metadata: metadata({ chapters: null }) })).media;
    expect(media.chapters).toEqual([
      { id: 0, start: 0, end: 60, title: 'track-1' },
      { id: 1, start: 60, end: 120, title: 'track-2' },
    ]);
  });
});
