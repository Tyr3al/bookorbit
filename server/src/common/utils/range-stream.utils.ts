import { createReadStream } from 'fs';
import type { FastifyReply } from 'fastify';

import { contentDispositionHeader } from './content-disposition.utils';

export interface SendFileStreamOptions {
  mimeType: string;
  filename: string;
  disposition?: 'inline' | 'attachment';
}

/**
 * Streams a file with HTTP Range support (206 + Content-Range, 416 for unsatisfiable
 * ranges), used by the web book API and the Audiobookshelf-compatible file endpoints.
 * Range handling mirrors what AVPlayer-class clients expect: Accept-Ranges, correct
 * Content-Length per slice, and a full-file fallback when the header is absent or malformed.
 */
export function sendFileStream(reply: FastifyReply, filePath: string, size: number, rangeHeader: string | undefined, options: SendFileStreamOptions) {
  reply.header('Accept-Ranges', 'bytes');
  reply.header('Content-Disposition', contentDispositionHeader(options.disposition ?? 'inline', options.filename, 'download'));
  reply.type(options.mimeType);

  if (rangeHeader) {
    const match = /bytes=(\d+)-(\d*)/.exec(rangeHeader);
    if (match) {
      const start = parseInt(match[1], 10);
      const end = match[2] ? parseInt(match[2], 10) : size - 1;
      if (start >= size || end < start || end >= size) {
        reply.status(416);
        reply.header('Content-Range', `bytes */${size}`);
        reply.send();
        return;
      }
      reply.status(206);
      reply.header('Content-Range', `bytes ${start}-${end}/${size}`);
      reply.header('Content-Length', end - start + 1);
      reply.send(createReadStream(filePath, { start, end }));
      return;
    }
  }

  reply.header('Content-Length', size);
  reply.send(createReadStream(filePath));
}
