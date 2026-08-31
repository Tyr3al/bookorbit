import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { RequestUser } from '../../../common/types/request-user';
import { toAbsCompositeUuid, toAbsUuid } from '../../../common/utils/abs-id.utils';
import type { AbsLibraryItem } from '../audiobookshelf.types';
import { AudiobookshelfPlaybackService } from './audiobookshelf-playback.service';

function user(): RequestUser {
  return {
    id: 7,
    username: 'listener',
    name: 'Listener',
    email: null,
    active: true,
    isSuperuser: false,
    isDefaultPassword: false,
    tokenVersion: 1,
    settings: {},
    avatarUrl: null,
    provisioningMethod: 'local',
    permissions: [],
    contentFilters: { includeTagIds: [], includeGenreIds: [], excludeTagIds: [], excludeGenreIds: [] },
  };
}

function item(): AbsLibraryItem {
  const fileMetadata = {
    filename: 'chapter-1.mp3',
    ext: 'mp3',
    path: '/srv/books/Book/chapter-1.mp3',
    relPath: 'chapter-1.mp3',
    size: 123,
    mtimeMs: 1,
    ctimeMs: 1,
    birthtimeMs: 1,
  };
  const audioFile = {
    index: 0,
    ino: '900',
    metadata: fileMetadata,
    addedAt: 1,
    updatedAt: 1,
    trackNumFromMeta: null,
    discNumFromMeta: null,
    trackNumFromFilename: 1,
    discNumFromFilename: null,
    manuallyVerified: false,
    exclude: false,
    error: null,
    format: 'mp3',
    duration: 120,
    bitRate: 128000,
    language: null,
    codec: 'mp3',
    timeBase: '1/1000',
    channels: 2,
    channelLayout: 'stereo',
    chapters: [],
    embeddedCoverArt: null,
    metaTags: {},
    mimeType: 'audio/mpeg',
  };
  const track = { ...audioFile, title: 'chapter-1.mp3', startOffset: 0, contentUrl: `/abs/api/items/${toAbsUuid(42)}/file/${toAbsUuid(900)}` };
  return {
    id: toAbsUuid(42),
    ino: '900',
    oldLibraryItemId: null,
    libraryId: toAbsUuid(3),
    folderId: toAbsUuid(4),
    path: '/srv/books/Book',
    relPath: 'Book/chapter-1.mp3',
    isFile: true,
    mtimeMs: 1,
    ctimeMs: 1,
    birthtimeMs: 1,
    addedAt: 1,
    updatedAt: 1,
    lastScan: 1,
    scanVersion: '2.36.0',
    isMissing: false,
    isInvalid: false,
    mediaType: 'book',
    media: {
      id: toAbsUuid(42),
      libraryItemId: toAbsUuid(42),
      metadata: {
        title: 'A Book',
        titleIgnorePrefix: 'A Book',
        subtitle: null,
        authors: [{ id: toAbsUuid(8), name: 'An Author' }],
        narrators: ['A Narrator'],
        series: [],
        genres: ['Fiction'],
        publishedYear: '2024',
        publishedDate: null,
        publisher: 'A Publisher',
        description: 'Description',
        descriptionPlain: 'Description',
        isbn: null,
        asin: null,
        language: 'en',
        explicit: false,
        abridged: false,
        authorName: 'An Author',
        authorNameLF: 'Author, An',
        narratorName: 'A Narrator',
        seriesName: '',
      },
      coverPath: '/metadata/items/42/cover.jpg',
      tags: [],
      audioFiles: [audioFile],
      chapters: [{ id: 0, start: 0, end: 120, title: 'Chapter 1' }],
      numTracks: 1,
      numAudioFiles: 1,
      numChapters: 1,
      duration: 120,
      size: 123,
      tracks: [track],
      ebookFile: null,
    },
    libraryFiles: [{ ino: '900', metadata: fileMetadata, addedAt: 1, updatedAt: 1, fileType: 'audio', isSupplementary: null }],
    numFiles: 1,
    size: 123,
  };
}

describe('AudiobookshelfPlaybackService', () => {
  it('returns a direct-play expanded session with a usable file URL', async () => {
    const sourceItem = item();
    const itemsService = { getItem: vi.fn().mockResolvedValue(sourceItem) };
    const progressService = { getMediaProgress: vi.fn().mockResolvedValue({ currentTime: 37 }) };
    const service = new AudiobookshelfPlaybackService(itemsService as never, progressService as never);

    const result = await service.play(user(), 42, {
      deviceInfo: { deviceId: 'phone-1', clientName: 'Prologue', clientVersion: '1.0', ignored: { large: true } },
      mediaPlayer: 'AVPlayer',
      forceTranscode: true,
    });

    expect(result).toMatchObject({
      id: toAbsCompositeUuid(7, 42),
      userId: toAbsUuid(7),
      libraryId: toAbsUuid(3),
      libraryItemId: toAbsUuid(42),
      mediaType: 'book',
      displayTitle: 'A Book',
      displayAuthor: 'An Author',
      duration: 120,
      playMethod: 0,
      mediaPlayer: 'AVPlayer',
      startTime: 37,
      currentTime: 37,
      audioTracks: [{ contentUrl: `/abs/api/items/${toAbsUuid(42)}/file/${toAbsUuid(900)}`, duration: 120 }],
    });
    expect(result.deviceInfo).toEqual({ deviceId: 'phone-1', clientName: 'Prologue', clientVersion: '1.0' });
    expect(result.libraryItem.path).toBe('Book/chapter-1.mp3');
    expect(result.audioTracks[0].metadata.path).toBe('chapter-1.mp3');
    expect(result.libraryItem.media.audioFiles[0].metadata.path).toBe('chapter-1.mp3');
    expect(JSON.stringify(result)).not.toContain('/srv/books');
  });

  it('does not build a session when the item is inaccessible', async () => {
    const itemsService = { getItem: vi.fn().mockRejectedValue(new NotFoundException()) };
    const progressService = { getMediaProgress: vi.fn() };
    const service = new AudiobookshelfPlaybackService(itemsService as never, progressService as never);

    await expect(service.play(user(), 42, {})).rejects.toBeInstanceOf(NotFoundException);
    expect(progressService.getMediaProgress).not.toHaveBeenCalled();
  });

  it('restarts finished books and rejects items without audio tracks', async () => {
    const sourceItem = item();
    const itemsService = { getItem: vi.fn().mockResolvedValue(sourceItem) };
    const progressService = { getMediaProgress: vi.fn().mockResolvedValue({ currentTime: 120, isFinished: true }) };
    const service = new AudiobookshelfPlaybackService(itemsService as never, progressService as never);

    await expect(service.play(user(), 42, {})).resolves.toMatchObject({ startTime: 0, currentTime: 0 });

    sourceItem.media.tracks = [];
    await expect(service.play(user(), 42, {})).rejects.toBeInstanceOf(NotFoundException);
  });

  it('syncs owned session fields through the shared progress service', async () => {
    const itemsService = { getItem: vi.fn() };
    const progressService = { updateMediaProgress: vi.fn().mockResolvedValue(undefined) };
    const service = new AudiobookshelfPlaybackService(itemsService as never, progressService as never);
    const currentUser = user();

    await service.sync(currentUser, toAbsCompositeUuid(7, 42), {
      currentTime: 123.5,
      duration: 3600,
      lastUpdate: 200,
      updatedAt: 100,
      isFinished: false,
      ignored: true,
    });

    expect(progressService.updateMediaProgress).toHaveBeenCalledWith(currentUser, 42, {
      currentTime: 123.5,
      duration: 3600,
      progress: undefined,
      startedAt: undefined,
      lastUpdate: 200,
      isFinished: false,
    });
  });

  it.each(['not-a-session', toAbsCompositeUuid(8, 42)])('rejects invalid or foreign session %s', async (sessionId) => {
    const progressService = { updateMediaProgress: vi.fn() };
    const service = new AudiobookshelfPlaybackService({} as never, progressService as never);

    await expect(service.sync(user(), sessionId, {})).rejects.toBeInstanceOf(NotFoundException);
    expect(progressService.updateMediaProgress).not.toHaveBeenCalled();
  });
});
