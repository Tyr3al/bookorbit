import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ZipArchive } from 'archiver';
import type { FastifyReply } from 'fastify';
import { basename } from 'path';

import { sendFileStream } from '../../../common/utils/range-stream.utils';
import { sanitizeLogValue } from '../../../common/utils/log-sanitize.utils';
import type { RequestUser } from '../../../common/types/request-user';
import { AudiobookshelfRepository } from '../audiobookshelf.repository';
import { resolveAbsAudioMimeType } from '../audiobookshelf.constants';
import { AudiobookshelfItemsService } from './audiobookshelf-items.service';

@Injectable()
export class AudiobookshelfStreamService {
  private readonly logger = new Logger(AudiobookshelfStreamService.name);

  constructor(
    private readonly repository: AudiobookshelfRepository,
    private readonly itemsService: AudiobookshelfItemsService,
  ) {}

  /** GET /api/items/:id/file/:fileId - Range-capable single audio file stream. */
  async streamFile(user: RequestUser, bookId: number, fileId: number, reply: FastifyReply, rangeHeader?: string) {
    const { path, size, format, originalFilename } = await this.itemsService.resolveFile(user, bookId, fileId);
    sendFileStream(reply, path, size, rangeHeader, {
      mimeType: resolveAbsAudioMimeType(format) ?? 'application/octet-stream',
      filename: originalFilename,
      disposition: 'inline',
    });
  }

  /** GET /api/items/:id/download - single file stream (Range-capable) or a zip of all audio files. */
  async download(user: RequestUser, bookId: number, reply: FastifyReply, rangeHeader?: string) {
    await this.itemsService.requireExposedBook(user, bookId);
    const files = await this.repository.findAudioFilesByBookId(bookId);
    if (files.length === 0) throw new NotFoundException(`Book ${bookId} has no audio files`);
    const orderedFiles = [...files].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id - b.id);

    if (orderedFiles.length === 1) {
      const { path, size, format, originalFilename } = await this.itemsService.resolveFile(user, bookId, orderedFiles[0].id);
      sendFileStream(reply, path, size, rangeHeader, {
        mimeType: resolveAbsAudioMimeType(format) ?? 'application/octet-stream',
        filename: originalFilename,
        disposition: 'attachment',
      });
      return;
    }

    await this.streamZip(
      user,
      bookId,
      orderedFiles.map((file) => file.absolutePath),
      reply,
    );
  }

  private async streamZip(user: RequestUser, bookId: number, filePaths: string[], reply: FastifyReply) {
    const event = 'audiobookshelf.download';
    const startedAt = Date.now();
    this.logger.log(`[${event}] [start] userId=${user.id} bookId=${bookId} files=${filePaths.length} - zip download started`);

    const archive = new ZipArchive({ zlib: { level: 0 } });
    let clientDisconnected = false;
    const handleDisconnect = () => {
      clientDisconnected = true;
      archive.abort();
    };
    reply.raw.on('close', handleDisconnect);
    reply.raw.on('aborted', handleDisconnect);
    const archiveFailure = new Promise<never>((_, reject) => {
      archive.on('warning', reject);
      archive.on('error', reject);
    });

    try {
      reply.raw.setHeader('Content-Type', 'application/zip');
      reply.raw.setHeader('Content-Disposition', `attachment; filename="book-${bookId}.zip"`);
      archive.pipe(reply.raw);
      for (const filePath of filePaths) {
        archive.file(filePath, { name: basename(filePath) });
      }
      await Promise.race([archive.finalize(), archiveFailure]);

      if (!clientDisconnected) {
        this.logger.log(
          `[${event}] [end] userId=${user.id} bookId=${bookId} files=${filePaths.length} durationMs=${Date.now() - startedAt} - zip download completed`,
        );
      }
    } catch (err) {
      if (clientDisconnected) {
        this.logger.log(
          `[${event}] [end] userId=${user.id} bookId=${bookId} files=${filePaths.length} durationMs=${Date.now() - startedAt} disconnected=true - zip download disconnected`,
        );
        return;
      }
      const errorClass = err instanceof Error ? err.name : 'Error';
      const errorMessage = sanitizeLogValue(err instanceof Error ? err.message : String(err));
      this.logger.warn(
        `[${event}] [fail] userId=${user.id} bookId=${bookId} files=${filePaths.length} durationMs=${Date.now() - startedAt} errorClass=${errorClass} error="${errorMessage}" - zip download failed`,
      );
      throw err;
    } finally {
      reply.raw.off('close', handleDisconnect);
      reply.raw.off('aborted', handleDisconnect);
    }
  }
}
