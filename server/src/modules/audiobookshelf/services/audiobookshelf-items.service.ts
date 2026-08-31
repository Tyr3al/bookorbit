import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';

import type { Book } from '../../../db/schema';
import { BookService } from '../../book/book.service';
import { AudiobookshelfRepository } from '../audiobookshelf.repository';
import type { AbsLibraryItem, AbsLibraryItemMinified } from '../audiobookshelf.types';
import {
  LibraryItemMapperService,
  type MapLibraryItemInput,
  type MapperAuthorRow,
  type MapperNarratorRow,
  type MapperSeriesRow,
} from './library-item-mapper.service';
import type { RequestUser } from '../../../common/types/request-user';
import { parseAbsId } from '../pipes/abs-id.pipe';

@Injectable()
export class AudiobookshelfItemsService {
  constructor(
    private readonly repository: AudiobookshelfRepository,
    private readonly mapper: LibraryItemMapperService,
    private readonly bookService: BookService,
  ) {}

  /** One item by id; 404 unless the book is exposed (opted-in library, user access, has audio). */
  async getItem(user: RequestUser, bookId: number): Promise<AbsLibraryItem> {
    await this.requireExposedBook(user, bookId);
    const items = await this.getItemsByIds([bookId]);
    if (items.length === 0) throw new NotFoundException(`Book ${bookId} not found`);
    return items[0];
  }

  /** Maps book ids to LibraryItem payloads, preserving input order. Batched, no N+1. */
  async getItemsByIds(bookIds: number[]): Promise<AbsLibraryItem[]> {
    return this.mapBookIds(bookIds, (input) => this.mapper.toLibraryItem(input));
  }

  /** Real ABS's leaner list/search shape - used everywhere except `GET /api/items/:id`. */
  async getMinifiedItemsByIds(bookIds: number[]): Promise<AbsLibraryItemMinified[]> {
    return this.mapBookIds(bookIds, (input) => this.mapper.toLibraryItemMinified(input));
  }

  /** ABS POST /api/items/batch/get - validates and maps a bounded all-or-nothing batch. */
  async getBatchItems(user: RequestUser, libraryItemIds: string[]): Promise<AbsLibraryItem[]> {
    if (!Array.isArray(libraryItemIds) || libraryItemIds.length === 0 || libraryItemIds.length > 100) {
      throw new BadRequestException('libraryItemIds must contain between 1 and 100 ids');
    }

    let bookIds: number[];
    try {
      bookIds = libraryItemIds.map((id) => parseAbsId(id));
    } catch {
      throw new BadRequestException('libraryItemIds contains an invalid id');
    }
    if (new Set(bookIds).size !== bookIds.length) throw new BadRequestException('libraryItemIds must not contain duplicates');

    const books = await this.repository.findExposedAudioBooksByIds(bookIds, user);
    if (books.length !== bookIds.length) throw new NotFoundException('One or more library items were not found');
    return this.mapBooks(bookIds, books, (input) => this.mapper.toLibraryItem(input));
  }

  private async mapBookIds<T>(bookIds: number[], toItem: (input: MapLibraryItemInput) => T): Promise<T[]> {
    if (bookIds.length === 0) return [];

    const books = await this.repository.findBooksByIds(bookIds);
    return this.mapBooks(bookIds, books, toItem);
  }

  private async mapBooks<T>(bookIds: number[], books: Book[], toItem: (input: MapLibraryItemInput) => T): Promise<T[]> {
    if (bookIds.length === 0) return [];

    const [metadataRows, files, authorRows, narratorRows, seriesRows, genreRows] = await Promise.all([
      this.repository.findMetadataByBookIds(bookIds),
      this.repository.findAudioFilesByBookIds(bookIds),
      this.repository.findAuthorsByBookIds(bookIds),
      this.repository.findNarratorsByBookIds(bookIds),
      this.repository.findSeriesByBookIds(bookIds),
      this.repository.findGenresByBookIds(bookIds),
    ]);

    const bookById = new Map(books.map((book) => [book.id, book]));
    const metadataById = new Map(metadataRows.map((row) => [row.bookId, row]));
    const byBook = <T extends { bookId: number }>(rows: T[]) => {
      const map = new Map<number, T[]>();
      for (const row of rows) {
        const list = map.get(row.bookId);
        if (list) list.push(row);
        else map.set(row.bookId, [row]);
      }
      return map;
    };
    const filesByBookId = byBook(files);
    const authorsByBookId = byBook(authorRows as MapperAuthorRow[]);
    const narratorsByBookId = byBook(narratorRows as MapperNarratorRow[]);
    const seriesByBookId = byBook(seriesRows as MapperSeriesRow[]);
    const genresByBookId = byBook(genreRows);

    const items: T[] = [];
    for (const bookId of bookIds) {
      const book = bookById.get(bookId);
      if (!book) continue;
      items.push(
        toItem({
          book,
          metadata: metadataById.get(bookId),
          audioFiles: filesByBookId.get(bookId) ?? [],
          authors: authorsByBookId.get(bookId) ?? [],
          narrators: narratorsByBookId.get(bookId) ?? [],
          series: seriesByBookId.get(bookId) ?? [],
          genres: genresByBookId.get(bookId) ?? [],
        }),
      );
    }
    return items;
  }

  /** Cover path for an exposed item (null when the book has no cover on disk). */
  async getCoverPath(user: RequestUser, bookId: number): Promise<string | null> {
    await this.requireExposedBook(user, bookId);
    return this.bookService.getCoverPath(bookId, user);
  }

  /** File info for an audio file of an exposed item (used by /file and /download).
   * ABS clients (Prologue) build their own file URL from `audioFile.ino` rather than the
   * `contentUrl` we hand back, so a plain-integer fileId that isn't one of our own ids is
   * resolved by matching it against the book's file `ino` values instead. */
  async resolveFile(user: RequestUser, bookId: number, fileId: number) {
    await this.requireExposedBook(user, bookId);
    const resolvedId = await this.resolveFileIdByIno(bookId, fileId);
    const file = await this.bookService.getFileInfo(resolvedId, user);
    if (file.bookId !== bookId) throw new NotFoundException(`File ${fileId} does not belong to book ${bookId}`);
    return file;
  }

  private async resolveFileIdByIno(bookId: number, fileId: number): Promise<number> {
    const files = await this.repository.findAudioFilesByBookId(bookId);
    if (files.some((file) => file.id === fileId)) return fileId;
    const byIno = files.find((file) => Number(file.ino) === fileId);
    return byIno?.id ?? fileId;
  }

  /** 404 unless the book exists, its library is opted in, and the user can access it. */
  async requireExposedBook(user: RequestUser, bookId: number): Promise<Book> {
    const book = await this.repository.findBookById(bookId);
    if (!book) throw new NotFoundException(`Book ${bookId} not found`);
    const exposed = await this.repository.isLibraryExposedForUser(book.libraryId, user.id, user.isSuperuser);
    if (!exposed) throw new NotFoundException(`Book ${bookId} not found`);
    return book;
  }
}
