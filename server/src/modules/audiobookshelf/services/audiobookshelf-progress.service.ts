import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';

import type { BookFile } from '../../../db/schema';
import { BookService } from '../../book/book.service';
import { AudiobookshelfRepository } from '../audiobookshelf.repository';
import { ABS_DEFAULT_IN_PROGRESS_LIMIT, ABS_FINISHED_PROGRESS, ABS_MAX_IN_PROGRESS_LIMIT } from '../audiobookshelf.constants';
import type { AbsLibraryItemMinified, AbsMediaProgress } from '../audiobookshelf.types';
import type { RequestUser } from '../../../common/types/request-user';
import { AudiobookshelfItemsService } from './audiobookshelf-items.service';
import { toAbsUuid, toAbsCompositeUuid, fromAbsCompositeUuid, fromAbsUuid } from '../../../common/utils/abs-id.utils';
import { sanitizeLogValue } from '../../../common/utils/log-sanitize.utils';

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
  private readonly logger = new Logger(AudiobookshelfProgressService.name);

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

  /** ABS GET /api/me/items-in-progress. Keep filtering, ordering, and limiting in SQL. */
  async getItemsInProgress(
    user: Pick<RequestUser, 'id' | 'isSuperuser'> & Partial<Pick<RequestUser, 'contentFilters'>>,
    requestedLimit?: number,
  ): Promise<{ libraryItems: (AbsLibraryItemMinified & { progressLastUpdate: number })[] }> {
    const limit = clampInProgressLimit(requestedLimit);
    const progressRows = await this.repository.findItemsInProgressForAudiobookshelfUser(user, limit);
    if (progressRows.length === 0) return { libraryItems: [] };

    const items = await this.itemsService.getMinifiedItemsByIds(progressRows.map((row) => row.bookId));
    const itemsById = new Map(items.map((item) => [item.id, item]));
    return {
      libraryItems: progressRows.flatMap((row) => {
        const item = itemsById.get(toAbsUuid(row.bookId));
        return item ? [{ ...item, progressLastUpdate: row.progressLastUpdate.getTime() }] : [];
      }),
    };
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
    const event = 'abs.progress_batch_update';
    const startedAt = Date.now();
    this.logger.log(`[${event}] [start] userId=${user.id} entries=${items.length} - progress batch update started`);
    try {
      const entries = items.flatMap((item) => {
        if (!item.libraryItemId) return [];
        const bookId = fromAbsUuid(item.libraryItemId);
        return bookId === null ? [] : [{ bookId, input: item }];
      });
      const outcome = await this.applyProgressBatch(user, entries);
      this.logger.log(
        `[${event}] [end] userId=${user.id} entries=${items.length} durationMs=${Date.now() - startedAt} applied=${outcome.applied} skipped=${outcome.skipped} failed=${outcome.failed} - progress batch update completed`,
      );
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.warn(
        `[${event}] [fail] userId=${user.id} entries=${items.length} durationMs=${Date.now() - startedAt} errorClass=${err.constructor.name} error="${sanitizeLogValue(err.message)}" - progress batch update failed`,
      );
      throw error;
    }
  }

  /** ABS POST /api/session/local-all - Prologue uploads locally-recorded listening sessions
   * here after offline playback. Sessions carry many fields BookOrbit has no use for (device
   * info, chapters, media metadata, ...), so the body is read as untyped JSON rather than a
   * whitelisted DTO - only the fields that map onto audiobook_progress are picked out. Real ABS
   * always answers with an empty results array regardless of input (confirmed against a real
   * server), so the response shape doesn't need to echo anything back. */
  async syncLocalSessions(user: RequestUser, sessions: unknown[]): Promise<{ results: unknown[] }> {
    const event = 'abs.local_session_sync';
    const startedAt = Date.now();
    this.logger.log(`[${event}] [start] userId=${user.id} entries=${sessions.length} - local session sync started`);
    try {
      const entries = sessions.flatMap((raw) => {
        const parsed = parseLocalSession(raw);
        return parsed ? [parsed] : [];
      });
      const outcome = await this.applyProgressBatch(user, entries);
      this.logger.log(
        `[${event}] [end] userId=${user.id} entries=${sessions.length} durationMs=${Date.now() - startedAt} applied=${outcome.applied} skipped=${outcome.skipped} failed=${outcome.failed} - local session sync completed`,
      );
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.warn(
        `[${event}] [fail] userId=${user.id} entries=${sessions.length} durationMs=${Date.now() - startedAt} errorClass=${err.constructor.name} error="${sanitizeLogValue(err.message)}" - local session sync failed`,
      );
      throw error;
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

  /** Shared write path for the batch progress endpoints: one access check, one file load, and
   * one progress load for the whole batch, then bounded-concurrency writes so failures on one
   * entry don't block or abort the others. Entries are grouped per book and each group is applied
   * in arrival order, because a client can upload several sessions for the same book in one batch
   * and an entry carrying no timestamp bypasses the atomic stale-write guard in the upsert. */
  private async applyProgressBatch(
    user: RequestUser,
    entries: { bookId: number; input: UpdateProgressInput }[],
  ): Promise<{ applied: number; skipped: number; failed: number }> {
    if (entries.length === 0) return { applied: 0, skipped: 0, failed: 0 };

    const bookIds = [...new Set(entries.map((entry) => entry.bookId))];
    const accessibleBooks = await this.repository.findExposedAudioBooksByIds(bookIds, user);
    const accessibleBookIds = new Set(accessibleBooks.map((book) => book.id));

    const accessibleEntries = entries.filter((entry) => accessibleBookIds.has(entry.bookId));
    let skipped = entries.length - accessibleEntries.length;
    if (accessibleEntries.length === 0) return { applied: 0, skipped, failed: 0 };

    const accessibleBookIdsArray = [...accessibleBookIds];
    const [files, progressRows] = await Promise.all([
      this.repository.findAudioFilesByBookIds(accessibleBookIdsArray),
      this.repository.findProgressByUserIdAndBookIds(user.id, accessibleBookIdsArray),
    ]);

    const filesByBookId = new Map<number, BookFile[]>();
    for (const file of files) {
      const list = filesByBookId.get(file.bookId);
      if (list) list.push(file);
      else filesByBookId.set(file.bookId, [file]);
    }
    const progressByBookId = new Map(progressRows.map((row) => [row.bookId, row]));

    const entriesByBookId = new Map<number, typeof accessibleEntries>();
    for (const entry of accessibleEntries) {
      const list = entriesByBookId.get(entry.bookId);
      if (list) list.push(entry);
      else entriesByBookId.set(entry.bookId, [entry]);
    }

    let applied = 0;
    let failed = 0;

    await runWithConcurrency([...entriesByBookId.values()], PROGRESS_BATCH_CONCURRENCY, async (group) => {
      const bookId = group[0].bookId;
      const orderedFiles = (filesByBookId.get(bookId) ?? []).slice().sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id - b.id);
      if (orderedFiles.length === 0) {
        skipped += group.length;
        return;
      }
      let lastUpdatedAt = progressByBookId.get(bookId)?.updatedAt;
      for (const entry of group) {
        try {
          const wasApplied = await this.applyProgressEntry(user, bookId, entry.input, orderedFiles, lastUpdatedAt);
          if (!wasApplied) {
            skipped++;
            continue;
          }
          applied++;
          lastUpdatedAt = resolveIncomingUpdatedAt(entry.input) ?? lastUpdatedAt;
        } catch {
          failed++;
        }
      }
    });

    return { applied, skipped, failed };
  }

  /** Writes a single batch entry against already-loaded files and the newest progress timestamp
   * known for the book. Returns false when the stale-write guard skips the write, matching
   * updateMediaProgress's no-op case. */
  private async applyProgressEntry(
    user: RequestUser,
    bookId: number,
    input: UpdateProgressInput,
    orderedFiles: BookFile[],
    existingUpdatedAt: Date | undefined,
  ): Promise<boolean> {
    const incomingUpdatedAt = resolveIncomingUpdatedAt(input);
    if (existingUpdatedAt && incomingUpdatedAt !== null && existingUpdatedAt.getTime() > incomingUpdatedAt.getTime()) {
      return false;
    }

    const totalDuration = orderedFiles.reduce((sum, file) => sum + (file.durationSeconds ?? 0), 0);
    const { currentFileId, positionSeconds, percentage } = this.resolvePosition(orderedFiles, totalDuration, input);
    const progress = { percentage, currentFileId, positionSeconds };

    if (incomingUpdatedAt !== null) {
      if (input.isFinished === undefined) {
        await this.bookService.saveAudioProgress(user.id, bookId, progress, user, incomingUpdatedAt);
      } else {
        await this.bookService.saveAudioProgress(user.id, bookId, progress, user, incomingUpdatedAt, input.isFinished);
      }
    } else {
      if (input.isFinished === undefined) {
        await this.bookService.saveAudioProgress(user.id, bookId, progress, user);
      } else {
        await this.bookService.saveAudioProgress(user.id, bookId, progress, user, undefined, input.isFinished);
      }
    }
    return true;
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

function clampInProgressLimit(value: number | undefined): number {
  if (value == null || !Number.isFinite(value) || value < 1) return ABS_DEFAULT_IN_PROGRESS_LIMIT;
  return Math.min(Math.floor(value), ABS_MAX_IN_PROGRESS_LIMIT);
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

const PROGRESS_BATCH_CONCURRENCY = 4;

/** Runs `task` over `items` with at most `limit` in flight at once. Each task is awaited within
 * its own worker loop, so a rejection there must be handled by the caller - this runner does not
 * swallow errors itself. */
async function runWithConcurrency<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workerCount = Math.min(limit, items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      await task(item);
    }
  });
  await Promise.all(workers);
}
