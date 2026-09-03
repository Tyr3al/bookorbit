import { Injectable } from '@nestjs/common';
import { basename } from 'path';

import type { Book, BookFile, BookMetadata, BookSeries, Narrator, Author } from '../../../db/schema';
import { AUDIOBOOKSHELF_BASE_PATH, AUDIOBOOKSHELF_SERVER_VERSION, resolveAudiobookshelfAudioMimeType } from '../audiobookshelf.constants';
import type {
  AudiobookshelfAudioFile,
  AudiobookshelfBookMedia,
  AudiobookshelfChapter,
  AudiobookshelfLibraryItem,
  AudiobookshelfLibraryItemMinified,
  AudiobookshelfTrack,
} from '../audiobookshelf.types';
import { toAudiobookshelfSeriesUuid, toAudiobookshelfUuid } from '../../../common/utils/audiobookshelf-id.utils';

export interface MapperAuthorRow extends Author {
  bookId: number;
}
export interface MapperNarratorRow extends Narrator {
  bookId: number;
}
export interface MapperSeriesRow extends BookSeries {
  bookId: number;
  seriesIndex: string | null;
}
export interface MapperGenreRow {
  bookId: number;
  name: string;
}

export interface MapLibraryItemInput {
  book: Book;
  metadata: BookMetadata | undefined;
  audioFiles: BookFile[];
  authors: MapperAuthorRow[];
  narrators: MapperNarratorRow[];
  series: MapperSeriesRow[];
  genres: MapperGenreRow[];
}

/** Converts BookOrbit book rows into Audiobookshelf LibraryItem payloads. */
@Injectable()
export class AudiobookshelfLibraryItemMapperService {
  toLibraryItem(input: MapLibraryItemInput): AudiobookshelfLibraryItem {
    const { book, metadata, audioFiles, authors, narrators, series, genres } = input;
    const bookId = toAudiobookshelfUuid(book.id);
    const orderedFiles = [...audioFiles].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id - b.id);

    const duration = metadata?.durationSeconds ?? sumDurations(orderedFiles);
    const size = orderedFiles.reduce((sum, file) => sum + (file.sizeBytes ?? 0), 0);
    const chapters = this.mapChapters(metadata, duration, orderedFiles);
    const tracks = this.mapTracks(bookId, orderedFiles);
    const firstFile = orderedFiles[0];

    const authorName = authors[0]?.name ?? '';
    const authorNameLF = authors[0]?.sortName ?? authors[0]?.name ?? '';
    const narratorName = narrators.map((n) => n.name).join(', ');
    // Real ABS composes this as "{name} #{sequence}" when a sequence is set, not the bare name.
    const firstSeries = series[0];
    const seriesName = firstSeries ? (firstSeries.seriesIndex ? `${firstSeries.name} #${firstSeries.seriesIndex}` : firstSeries.name) : '';

    const absMetadata = {
      title: metadata?.title ?? '',
      titleIgnorePrefix: metadata?.title ?? '',
      subtitle: metadata?.subtitle ?? null,
      authors: authors.map((author) => ({ id: toAudiobookshelfUuid(author.id), name: author.name })),
      narrators: narrators.map((n) => n.name),
      series: series.map((s) => ({ id: toAudiobookshelfSeriesUuid(s.id), name: s.name, sequence: s.seriesIndex })),
      genres: genres.map((g) => g.name),
      publishedYear: metadata?.publishedYear != null ? String(metadata.publishedYear) : null,
      publishedDate: metadata?.publishedDate ?? null,
      publisher: metadata?.publisher ?? null,
      description: metadata?.description ?? null,
      descriptionPlain: metadata?.description ?? null,
      isbn: metadata?.isbn13 ?? metadata?.isbn10 ?? null,
      asin: null,
      language: metadata?.language ?? null,
      explicit: false,
      abridged: metadata?.abridged ?? false,
      authorName,
      authorNameLF,
      narratorName,
      seriesName,
    };

    const media: AudiobookshelfBookMedia = {
      id: bookId,
      libraryItemId: bookId,
      metadata: absMetadata,
      // Real ABS clients treat a null coverPath as "no cover" and skip fetching one, even though
      // the actual cover bytes always come from GET /api/items/:id/cover regardless of this
      // value's content - so it only needs to be non-null when a cover exists on disk.
      coverPath: metadata?.coverSource ? `/metadata/items/${book.id}/cover.jpg` : null,
      tags: [],
      audioFiles: orderedFiles.map((file, index) => this.mapAudioFile(file, index)),
      chapters,
      numTracks: orderedFiles.length,
      numAudioFiles: orderedFiles.length,
      numChapters: chapters.length,
      duration,
      size,
      tracks,
      ebookFile: null,
    };

    return {
      id: bookId,
      ino: firstFile ? String(firstFile.ino) : '0',
      oldLibraryItemId: null,
      libraryId: toAudiobookshelfUuid(book.libraryId),
      folderId: toAudiobookshelfUuid(book.libraryFolderId),
      path: book.folderPath,
      relPath: firstFile?.relPath ?? basename(book.folderPath),
      isFile: orderedFiles.length === 1,
      mtimeMs: book.updatedAt.getTime(),
      ctimeMs: book.addedAt.getTime(),
      birthtimeMs: book.addedAt.getTime(),
      addedAt: book.addedAt.getTime(),
      updatedAt: book.updatedAt.getTime(),
      lastScan: book.updatedAt.getTime(),
      scanVersion: AUDIOBOOKSHELF_SERVER_VERSION,
      isMissing: book.status === 'missing',
      isInvalid: false,
      mediaType: 'book',
      media,
      libraryFiles: orderedFiles.map((file) => ({
        ino: String(file.ino),
        metadata: this.mapFileMetadata(file),
        addedAt: file.createdAt.getTime(),
        updatedAt: file.updatedAt.getTime(),
        fileType: 'audio' as const,
        isSupplementary: null,
      })),
      numFiles: orderedFiles.length,
      size,
    };
  }

  /** Real ABS uses this leaner shape (no per-file/track/chapter/author-id detail) for paginated
   * list and search results; `GET /api/items/:id` alone returns the full expanded item. */
  toLibraryItemMinified(input: MapLibraryItemInput): AudiobookshelfLibraryItemMinified {
    const full = this.toLibraryItem(input);
    return {
      id: full.id,
      ino: full.ino,
      oldLibraryItemId: full.oldLibraryItemId,
      libraryId: full.libraryId,
      folderId: full.folderId,
      path: full.path,
      relPath: full.relPath,
      isFile: full.isFile,
      mtimeMs: full.mtimeMs,
      ctimeMs: full.ctimeMs,
      birthtimeMs: full.birthtimeMs,
      addedAt: full.addedAt,
      updatedAt: full.updatedAt,
      isMissing: full.isMissing,
      isInvalid: full.isInvalid,
      mediaType: full.mediaType,
      numFiles: full.numFiles,
      size: full.size,
      media: {
        id: full.media.id,
        metadata: {
          title: full.media.metadata.title,
          titleIgnorePrefix: full.media.metadata.titleIgnorePrefix,
          subtitle: full.media.metadata.subtitle,
          authorName: full.media.metadata.authorName,
          authorNameLF: full.media.metadata.authorNameLF,
          narratorName: full.media.metadata.narratorName,
          seriesName: full.media.metadata.seriesName,
          genres: full.media.metadata.genres,
          publishedYear: full.media.metadata.publishedYear,
          publishedDate: full.media.metadata.publishedDate,
          publisher: full.media.metadata.publisher,
          description: full.media.metadata.description,
          isbn: full.media.metadata.isbn,
          asin: full.media.metadata.asin,
          language: full.media.metadata.language,
          explicit: full.media.metadata.explicit,
          abridged: full.media.metadata.abridged,
        },
        coverPath: full.media.coverPath,
        tags: full.media.tags,
        numTracks: full.media.numTracks,
        numAudioFiles: full.media.numAudioFiles,
        numChapters: full.media.numChapters,
        duration: full.media.duration,
        size: full.media.size,
      },
    };
  }

  private mapAudioFile(file: BookFile, index: number): AudiobookshelfAudioFile {
    const mimeType = resolveAudiobookshelfAudioMimeType(file.format) ?? 'application/octet-stream';
    // Real ABS's client models several probe-derived fields (bitRate/codec/timeBase/channels/
    // channelLayout) as non-optional, so a best-effort estimate stands in for values BookOrbit
    // doesn't store from its own scan.
    const bitRate = file.sizeBytes != null && file.durationSeconds ? Math.round((file.sizeBytes * 8) / file.durationSeconds) : 128000;
    return {
      index,
      ino: String(file.ino),
      metadata: this.mapFileMetadata(file),
      addedAt: file.createdAt.getTime(),
      updatedAt: file.updatedAt.getTime(),
      trackNumFromMeta: null,
      discNumFromMeta: null,
      trackNumFromFilename: extractLeadingNumber(basename(file.absolutePath)),
      discNumFromFilename: null,
      manuallyVerified: false,
      exclude: false,
      error: null,
      format: file.format ?? '',
      duration: file.durationSeconds,
      bitRate,
      language: null,
      codec: file.format ?? 'unknown',
      timeBase: '1/1000',
      channels: 2,
      channelLayout: 'stereo',
      chapters: [],
      embeddedCoverArt: null,
      metaTags: {},
      mimeType,
    };
  }

  private mapTracks(bookId: string, orderedFiles: BookFile[]): AudiobookshelfTrack[] {
    let startOffset = 0;
    return orderedFiles.map((file, index) => {
      const track: AudiobookshelfTrack = {
        ...this.mapAudioFile(file, index),
        title: basename(file.absolutePath),
        startOffset,
        contentUrl: `${AUDIOBOOKSHELF_BASE_PATH}/api/items/${bookId}/file/${toAudiobookshelfUuid(file.id)}`,
      };
      startOffset += file.durationSeconds ?? 0;
      return track;
    });
  }

  private mapFileMetadata(file: BookFile) {
    const filename = basename(file.absolutePath);
    const ext = file.format ?? (filename.includes('.') ? filename.split('.').pop()! : '');
    return {
      filename,
      ext,
      path: file.absolutePath,
      relPath: file.relPath ?? filename,
      size: file.sizeBytes ?? 0,
      mtimeMs: file.mtime?.getTime() ?? 0,
      ctimeMs: file.createdAt.getTime(),
      birthtimeMs: file.createdAt.getTime(),
    };
  }

  /**
   * BookOrbit stores chapters as `{ title, startMs }` lists already merged across files.
   * ABS wants `{ id, start, end, title }` with times in seconds; each chapter ends where the
   * next starts, and the last chapter ends at the total duration.
   */
  private mapChapters(metadata: BookMetadata | undefined, totalDuration: number | null, orderedFiles: BookFile[]): AudiobookshelfChapter[] {
    const raw = metadata?.chapters;
    if (Array.isArray(raw) && raw.length > 0) {
      return raw.map((chapter, index) => {
        const start = Number(chapter.startMs ?? 0) / 1000;
        const end = index + 1 < raw.length ? Number(raw[index + 1].startMs ?? 0) / 1000 : (totalDuration ?? start);
        return { id: index, start, end: end >= start ? end : start, title: String(chapter.title ?? '') };
      });
    }
    // Real ABS's scanner falls back to one chapter per audio file (titled from the filename)
    // when no explicit chapter markers exist - never an empty list for a scanned book.
    let start = 0;
    return orderedFiles.map((file, index) => {
      const fileDuration = file.durationSeconds ?? 0;
      const end = start + fileDuration;
      const chapter = { id: index, start, end, title: basename(file.absolutePath).replace(/\.[^./]+$/, '') };
      start = end;
      return chapter;
    });
  }
}

function extractLeadingNumber(filename: string): number | null {
  const match = /^(\d+)/.exec(filename);
  return match ? Number(match[1]) : null;
}

function sumDurations(files: BookFile[]): number | null {
  const total = files.reduce((sum, file) => sum + (file.durationSeconds ?? 0), 0);
  return files.some((file) => file.durationSeconds == null) ? null : total;
}
