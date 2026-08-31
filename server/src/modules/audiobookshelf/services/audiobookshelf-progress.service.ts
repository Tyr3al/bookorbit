import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';

import type { BookFile } from '../../../db/schema';
import { BookService } from '../../book/book.service';
import { AudiobookshelfRepository } from '../audiobookshelf.repository';
import { ABS_FINISHED_PROGRESS } from '../audiobookshelf.constants';
import type { AbsMediaProgress } from '../audiobookshelf.types';
import type { RequestUser } from '../../../common/types/request-user';
import { AudiobookshelfItemsService } from './audiobookshelf-items.service';
import { toAbsUuid, toAbsCompositeUuid, fromAbsCompositeUuid, fromAbsUuid } from '../../../common/utils/abs-id.utils';

export interface UpdateProgressInput {
  currentTime?: number;
  duration?: number;
  progress?: number;
  isFinished?: boolean;
  startedAt?: number;
  lastUpdate?: number;
}

@Injectable()
export class AudiobookshelfProgressService {
  constructor(
    private readonly repository: AudiobookshelfRepository,
    private readonly bookService: BookService,
    private readonly itemsService: AudiobookshelfItemsService,
  ) {}

  /** Progress rows for books visible through the user's exposed ABS libraries. */
  async getMediaProgressForUser(
    user: Pick<RequestUser, 'id' | 'isSuperuser'> & Partial<Pick<RequestUser, 'contentFilters'>>,
    bookIds?: number[],
  ): Promise<AbsMediaProgress[]> {
    const rows = bookIds
      ? await this.repository.findProgressByUserIdAndBookIds(user.id, bookIds)
      : await this.repository.findProgressForAudiobookshelfUser(user);
    if (rows.length === 0) return [];

    const progressBookIds = [...new Set(rows.map((row) => row.bookId))];
    const files = await this.repository.findAudioFilesByBookIds(progressBookIds);
    const filesByBookId = new Map<number, BookFile[]>();
    for (const file of files) {
      const list = filesByBookId.get(file.bookId);
      if (list) list.push(file);
      else filesByBookId.set(file.bookId, [file]);
    }

    return rows.map((row) => this.toMediaProgress(row, filesByBookId.get(row.bookId) ?? []));
  }

  /** Read a single item's progress (ABS GET /api/me/progress/:libraryItemId). */
  async getMediaProgress(user: RequestUser, libraryItemId: number): Promise<AbsMediaProgress | null> {
    const book = await this.requireExposedBook(user, libraryItemId);
    const rows = await this.repository.findProgressByUserIdAndBookIds(user.id, [book.id]);
    if (rows.length === 0) return null;
    const files = await this.repository.findAudioFilesByBookId(book.id);
    return this.toMediaProgress(rows[0], files);
  }

  /** ABS DELETE /api/me/progress/:id, where id identifies the user and library item. */
  async deleteMediaProgress(user: RequestUser, progressId: string): Promise<void> {
    const composite = fromAbsCompositeUuid(progressId);
    if (!composite || composite.a !== user.id) throw new NotFoundException('Progress not found');

    await this.requireExposedBook(user, composite.b);
    const deleted = await this.repository.deleteProgressByUserIdAndBookId(user.id, composite.b);
    if (!deleted) throw new NotFoundException('Progress not found');
  }

  /** ABS PATCH /api/me/progress/:libraryItemId - maps the payload onto audiobook_progress. */
  async updateMediaProgress(user: RequestUser, libraryItemId: number, input: UpdateProgressInput): Promise<AbsMediaProgress> {
    const book = await this.requireExposedBook(user, libraryItemId);
    const files = await this.repository.findAudioFilesByBookId(book.id);
    if (files.length === 0) throw new NotFoundException(`Book ${book.id} has no audio files`);

    const orderedFiles = [...files].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id - b.id);
    const existingRows = await this.repository.findProgressByUserIdAndBookIds(user.id, [book.id]);
    const existing = existingRows[0];
    const incomingUpdatedAt = resolveIncomingUpdatedAt(input);
    if (existing && incomingUpdatedAt !== null && existing.updatedAt.getTime() > incomingUpdatedAt.getTime()) {
      return this.toMediaProgress(existing, orderedFiles);
    }
    const totalDuration = orderedFiles.reduce((sum, file) => sum + (file.durationSeconds ?? 0), 0);

    const { currentFileId, positionSeconds, percentage } = this.resolvePosition(orderedFiles, totalDuration, input);
    const progress = { percentage, currentFileId, positionSeconds };
    if (incomingUpdatedAt !== null) {
      if (input.isFinished === undefined) {
        await this.bookService.saveAudioProgress(user.id, book.id, progress, user, incomingUpdatedAt);
      } else {
        await this.bookService.saveAudioProgress(user.id, book.id, progress, user, incomingUpdatedAt, input.isFinished);
      }
    } else {
      if (input.isFinished === undefined) {
        await this.bookService.saveAudioProgress(user.id, book.id, progress, user);
      } else {
        await this.bookService.saveAudioProgress(user.id, book.id, progress, user, undefined, input.isFinished);
      }
    }

    const rows = await this.repository.findProgressByUserIdAndBookIds(user.id, [book.id]);
    return this.toMediaProgress(rows[0], orderedFiles);
  }

  /** ABS PATCH /api/me/progress/batch/update - applies each entry, skipping ones that fail
   * (unknown/inaccessible item) rather than rejecting the whole batch, matching real ABS. */
  async batchUpdateMediaProgress(user: RequestUser, items: (UpdateProgressInput & { libraryItemId?: string })[]): Promise<void> {
    for (const item of items) {
      if (!item.libraryItemId) continue;
      const bookId = fromAbsUuid(item.libraryItemId);
      if (bookId === null) continue;
      try {
        await this.updateMediaProgress(user, bookId, item);
      } catch {
        // Real ABS logs and continues on a per-item failure rather than aborting the batch.
      }
    }
  }

  /** ABS POST /api/session/local-all - Prologue uploads locally-recorded listening sessions
   * here after offline playback. Sessions carry many fields BookOrbit has no use for (device
   * info, chapters, media metadata, ...), so the body is read as untyped JSON rather than a
   * whitelisted DTO - only the fields that map onto audiobook_progress are picked out. Real ABS
   * always answers with an empty results array regardless of input (confirmed against a real
   * server), so the response shape doesn't need to echo anything back. */
  async syncLocalSessions(user: RequestUser, sessions: unknown[]): Promise<{ results: unknown[] }> {
    for (const raw of sessions) {
      const parsed = parseLocalSession(raw);
      if (!parsed) continue;
      try {
        await this.updateMediaProgress(user, parsed.bookId, parsed.input);
      } catch {
        // Tolerate a single bad/inaccessible session rather than failing the whole upload.
      }
    }
    return { results: [] };
  }

  /** ABS POST /api/session/local - records one locally-recorded listening session. */
  async syncLocalSession(user: RequestUser, raw: unknown): Promise<void> {
    const parsed = parseLocalSession(raw);
    if (!parsed) throw new BadRequestException('Invalid local playback session');
    await this.updateMediaProgress(user, parsed.bookId, parsed.input);
  }

  toMediaProgress(
    row: { userId: number; bookId: number; percentage: number; currentFileId: number; positionSeconds: number; updatedAt: Date },
    files: BookFile[],
  ): AbsMediaProgress {
    const orderedFiles = [...files].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id - b.id);
    const duration = orderedFiles.reduce((sum, file) => sum + (file.durationSeconds ?? 0), 0) || null;
    const currentTime = this.absolutePosition(orderedFiles, row.currentFileId, row.positionSeconds);
    const progress = row.percentage / 100;
    const updatedAt = row.updatedAt.getTime();

    return {
      id: toAbsCompositeUuid(row.userId, row.bookId),
      userId: toAbsUuid(row.userId),
      libraryItemId: toAbsUuid(row.bookId),
      episodeId: null,
      mediaItemId: toAbsUuid(row.bookId),
      mediaItemType: 'book',
      duration,
      progress,
      currentTime,
      isFinished: progress >= ABS_FINISHED_PROGRESS,
      hideFromContinueListening: false,
      startedAt: updatedAt,
      lastUpdate: updatedAt,
      createdAt: updatedAt,
      updatedAt,
      finishedAt: null,
      ebookLocation: null,
      ebookProgress: null,
    };
  }

  private async requireExposedBook(user: RequestUser, bookId: number): Promise<{ id: number }> {
    const book = await this.itemsService.requireExposedBook(user, bookId);
    return { id: book.id };
  }

  /** Maps an ABS position (seconds into the whole book) to a file id + file-local seconds. */
  private resolvePosition(
    orderedFiles: BookFile[],
    totalDuration: number,
    input: UpdateProgressInput,
  ): { currentFileId: number; positionSeconds: number; percentage: number } {
    let currentTime: number;
    if (input.currentTime != null && Number.isFinite(input.currentTime)) {
      currentTime = input.currentTime;
    } else if (input.progress != null && Number.isFinite(input.progress)) {
      currentTime = totalDuration > 0 ? input.progress * totalDuration : 0;
    } else {
      currentTime = 0;
    }
    currentTime = Math.max(0, totalDuration > 0 ? Math.min(currentTime, totalDuration) : currentTime);

    let cursor = 0;
    let file = orderedFiles[0];
    for (const candidate of orderedFiles) {
      const fileDuration = candidate.durationSeconds ?? 0;
      if (currentTime < cursor + fileDuration || candidate === orderedFiles[orderedFiles.length - 1]) {
        file = candidate;
        break;
      }
      cursor += fileDuration;
    }

    const positionSeconds = Math.max(0, currentTime - cursor);
    const percentage = totalDuration > 0 ? Math.min(100, (currentTime / totalDuration) * 100) : (input.progress ?? 0) * 100;
    return { currentFileId: file.id, positionSeconds, percentage: roundPercentage(percentage) };
  }

  private absolutePosition(orderedFiles: BookFile[], currentFileId: number, positionSeconds: number): number {
    let offset = 0;
    for (const file of orderedFiles) {
      if (file.id === currentFileId) return offset + positionSeconds;
      offset += file.durationSeconds ?? 0;
    }
    return offset + positionSeconds;
  }
}

function roundPercentage(value: number): number {
  return Math.round(value * 100) / 100;
}

function resolveIncomingUpdatedAt(input: UpdateProgressInput): Date | null {
  const timestamp = input.lastUpdate ?? input.startedAt;
  if (timestamp == null || !Number.isFinite(timestamp) || timestamp < 0) return null;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseLocalSession(raw: unknown): { bookId: number; input: UpdateProgressInput } | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const session = raw as Record<string, unknown>;
  if (typeof session.libraryItemId !== 'string') return null;
  const bookId = fromAbsUuid(session.libraryItemId);
  if (bookId === null) return null;
  const currentTime = finiteNumber(session.currentTime);
  const progress = finiteNumber(session.progress);
  if (currentTime === undefined && progress === undefined) return null;

  return {
    bookId,
    input: {
      currentTime,
      progress,
      duration: finiteNumber(session.duration),
      startedAt: finiteNumber(session.startedAt),
      lastUpdate: finiteNumber(session.lastUpdate) ?? finiteNumber(session.updatedAt),
      isFinished: typeof session.isFinished === 'boolean' ? session.isFinished : undefined,
    },
  };
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
