import { describe, expect, it, vi } from 'vitest';

import { toAudiobookshelfUuid } from '../../../common/utils/audiobookshelf-id.utils';
import type { RequestUser } from '../../../common/types/request-user';
import { AUDIOBOOKSHELF_LIVE_SESSION_GAP_MS } from '../audiobookshelf.constants';
import { AudiobookshelfSessionsService, readDeviceId, type LiveListeningReport } from './audiobookshelf-sessions.service';
import type { ListeningSessionRow } from './audiobookshelf-sessions.repository';

const user = { id: 3, isSuperuser: false, settings: { timezone: 'Europe/Berlin' }, contentFilters: {} } as unknown as RequestUser;
const now = new Date('2026-03-02T10:00:00Z');

function makeService() {
  const repository = {
    findPage: vi.fn().mockResolvedValue({ rows: [], total: 0 }),
    findStatsAggregate: vi.fn(),
  };
  const audiobookshelfRepository = {
    findMetadataByBookIds: vi.fn().mockResolvedValue([{ bookId: 7, title: 'Dune', subtitle: null, coverSource: 'embedded' }]),
    findAuthorsByBookIds: vi.fn().mockResolvedValue([{ bookId: 7, name: 'Frank Herbert' }]),
    findAudioFilesByBookIds: vi.fn().mockResolvedValue([
      { bookId: 7, durationSeconds: 600 },
      { bookId: 7, durationSeconds: 400 },
    ]),
  };
  const itemsService = { requireExposedBook: vi.fn().mockResolvedValue({ id: 7 }) };
  const readingSessions = {
    findLatestSourceSession: vi.fn().mockResolvedValue(null),
    recordListeningSession: vi.fn().mockResolvedValue({ kind: 'saved' }),
  };
  const service = new AudiobookshelfSessionsService(
    repository as never,
    audiobookshelfRepository as never,
    itemsService as never,
    readingSessions as never,
  );
  return { service, repository, itemsService, readingSessions };
}

function report(overrides: Partial<LiveListeningReport> = {}): LiveListeningReport {
  return { bookId: 7, bookFileId: 70, listenedSeconds: 15, startProgress: 10, endProgress: 11.5, deviceKey: 'phone-1', now, ...overrides };
}

function row(overrides: Partial<ListeningSessionRow> = {}): ListeningSessionRow {
  return {
    id: 501,
    bookId: 7,
    libraryId: 2,
    source: null,
    sourceDeviceKey: 'abs:phone-1',
    startedAt: new Date('2026-03-01T23:30:00Z'),
    endedAt: new Date('2026-03-01T23:50:00Z'),
    durationSeconds: 1200,
    progressDelta: 20,
    endProgress: 50,
    ...overrides,
  };
}

describe('AudiobookshelfSessionsService.recordLiveListening', () => {
  it('starts a listen session backdated by the reported listening when no session is open', async () => {
    const { service, readingSessions } = makeService();

    await service.recordLiveListening(user, report());

    expect(readingSessions.findLatestSourceSession).toHaveBeenCalledWith({
      userId: 3,
      bookId: 7,
      sourceDeviceKey: 'abs:phone-1',
      sessionIdPrefix: 'abs-live:',
      endedAfter: new Date(now.getTime() - AUDIOBOOKSHELF_LIVE_SESSION_GAP_MS),
    });
    expect(readingSessions.recordListeningSession).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 3,
        bookFileId: 70,
        sessionId: expect.stringMatching(/^abs-live:/),
        startedAt: new Date(now.getTime() - 15_000),
        endedAt: now,
        durationSeconds: 15,
        progressDelta: 1.5,
        endProgress: 11.5,
        source: null,
        sourceDeviceKey: 'abs:phone-1',
        timeZone: 'Europe/Berlin',
      }),
    );
  });

  it('grows the open session and keeps its start and starting progress', async () => {
    const { service, readingSessions } = makeService();
    const startedAt = new Date(now.getTime() - 300_000);
    readingSessions.findLatestSourceSession.mockResolvedValue({
      sessionId: 'abs-live:abc',
      startedAt,
      endedAt: new Date(now.getTime() - 15_000),
      durationSeconds: 280,
      progressDelta: 4,
      endProgress: 14,
    });

    await service.recordLiveListening(user, report({ startProgress: 14, endProgress: 15 }));

    expect(readingSessions.recordListeningSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'abs-live:abc', startedAt, endedAt: now, durationSeconds: 295, progressDelta: 5, endProgress: 15 }),
    );
  });

  it('keys sessions by a default device when the client sent no device id', async () => {
    const { service, readingSessions } = makeService();

    await service.recordLiveListening(user, report({ deviceKey: null }));

    expect(readingSessions.findLatestSourceSession).toHaveBeenCalledWith(expect.objectContaining({ sourceDeviceKey: 'abs:default' }));
  });

  it.each([0, -20, Number.NaN])('ignores a report with %s listened seconds', async (listenedSeconds) => {
    const { service, readingSessions } = makeService();

    await service.recordLiveListening(user, report({ listenedSeconds }));

    expect(readingSessions.recordListeningSession).not.toHaveBeenCalled();
  });

  it('swallows a persistence failure so playback sync still succeeds', async () => {
    const { service, readingSessions } = makeService();
    readingSessions.recordListeningSession.mockRejectedValue(new Error('db down'));

    await expect(service.recordLiveListening(user, report())).resolves.toBeUndefined();
  });
});

describe('AudiobookshelfSessionsService.recordLocalSessions', () => {
  const local = {
    bookId: 7,
    bookFileId: 71,
    clientSessionId: 'play_local_9f2',
    startedAt: new Date('2026-03-01T08:00:00Z'),
    updatedAt: new Date('2026-03-01T08:40:00Z'),
    timeListening: 2300,
    startProgress: 20,
    endProgress: 31.25,
    deviceKey: 'tablet',
  };

  it('keys each offline session by the client session id so re-uploads grow it instead of duplicating', async () => {
    const { service, readingSessions } = makeService();

    await service.recordLocalSessions(user, [local]);

    expect(readingSessions.recordListeningSession).toHaveBeenCalledWith({
      userId: 3,
      bookFileId: 71,
      sessionId: 'abs-local:play_local_9f2',
      startedAt: local.startedAt,
      endedAt: local.updatedAt,
      durationSeconds: 2300,
      progressDelta: 11.25,
      endProgress: 31.25,
      source: null,
      sourceDeviceKey: 'abs:tablet',
      timeZone: 'Europe/Berlin',
    });
  });

  it('derives a stable id when the client sent none, and strips unsafe characters from client ids', async () => {
    const { service, readingSessions } = makeService();

    await service.recordLocalSessions(user, [
      { ...local, clientSessionId: null },
      { ...local, clientSessionId: 'a b/c%d' },
    ]);

    expect(readingSessions.recordListeningSession.mock.calls.map(([params]) => params.sessionId)).toEqual([
      `abs-local:7-${local.startedAt.getTime()}`,
      'abs-local:abcd',
    ]);
  });

  it('keeps going after one session fails', async () => {
    const { service, readingSessions } = makeService();
    readingSessions.recordListeningSession.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ kind: 'saved' });

    await service.recordLocalSessions(user, [local, { ...local, clientSessionId: 'second' }]);

    expect(readingSessions.recordListeningSession).toHaveBeenCalledTimes(2);
  });
});

describe('AudiobookshelfSessionsService reads', () => {
  it('bounds pagination and maps reading sessions onto the upstream playback-session shape', async () => {
    const { service, repository } = makeService();
    repository.findPage.mockResolvedValue({ rows: [row()], total: 23 });

    const result = await service.getSessionsPage(user, 2, 500);

    expect(repository.findPage).toHaveBeenCalledWith(user, 100, 200);
    expect(result).toMatchObject({ total: 23, numPages: 1, page: 2, itemsPerPage: 100 });
    expect(result.sessions[0]).toMatchObject({
      id: toAudiobookshelfUuid(501),
      libraryItemId: toAudiobookshelfUuid(7),
      libraryId: toAudiobookshelfUuid(2),
      displayTitle: 'Dune',
      displayAuthor: 'Frank Herbert',
      coverPath: '/metadata/items/7/cover.jpg',
      duration: 1000,
      mediaPlayer: 'audiobookshelf',
      deviceInfo: { deviceId: 'phone-1' },
      // 23:30 UTC is already the next day in Berlin.
      date: '2026-03-02',
      dayOfWeek: 'Monday',
      timeListening: 1200,
      startTime: 300,
      currentTime: 500,
    });
  });

  it('defaults itemsPerPage to 10 and clamps a fractional page', async () => {
    const { service, repository } = makeService();

    const result = await service.getSessionsPage(user, 1.7, Number.NaN);

    expect(repository.findPage).toHaveBeenCalledWith(user, 10, 10);
    expect(result).toEqual({ total: 0, numPages: 0, page: 1, itemsPerPage: 10, sessions: [] });
  });

  it.each([
    [{ source: 'web' as const, sourceDeviceKey: null }, 'web'],
    [{ source: null, sourceDeviceKey: null }, 'bookorbit'],
    [{ source: 'koreader' as const, sourceDeviceKey: 'abs:spoofed' }, 'koreader'],
  ])('labels sessions from other BookOrbit surfaces by their source (%j)', async (overrides, mediaPlayer) => {
    const { service, repository } = makeService();
    repository.findPage.mockResolvedValue({ rows: [row(overrides)], total: 1 });

    const result = await service.getSessionsPage(user, 0, 10);

    expect(result.sessions[0]).toMatchObject({ mediaPlayer, deviceInfo: null });
  });

  it('omits the device for ABS sessions recorded without a device id', async () => {
    const { service, repository } = makeService();
    repository.findPage.mockResolvedValue({ rows: [row({ sourceDeviceKey: 'abs:default' })], total: 1 });

    const result = await service.getSessionsPage(user, 0, 10);

    expect(result.sessions[0]).toMatchObject({ mediaPlayer: 'audiobookshelf', deviceInfo: null });
  });

  it('scopes the item route through the exposed-book check', async () => {
    const { service, repository, itemsService } = makeService();
    itemsService.requireExposedBook.mockRejectedValue(new Error('not found'));

    await expect(service.getItemSessionsPage(user, 7, 0, 10)).rejects.toThrow('not found');
    expect(repository.findPage).not.toHaveBeenCalled();
  });

  it('keys stats aggregates by ABS uuid with metadata and epoch lastUpdate', async () => {
    const { service, repository } = makeService();
    const lastUpdate = new Date('2026-03-01T23:50:00Z');
    repository.findStatsAggregate.mockResolvedValue({
      totals: { totalTime: 1200, today: 0 },
      days: [{ date: '2026-03-02', seconds: 1200 }],
      dayOfWeek: [{ dayOfWeek: 'Monday', seconds: 1200 }],
      items: [{ bookId: 7, timeListening: 1200, lastUpdate }],
    });
    repository.findPage.mockResolvedValue({ rows: [row()], total: 1 });

    const stats = await service.getListeningStats(user);

    expect(repository.findStatsAggregate).toHaveBeenCalledWith(user, 'Europe/Berlin', expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
    expect(stats.items).toEqual({
      [toAudiobookshelfUuid(7)]: {
        id: toAudiobookshelfUuid(7),
        timeListening: 1200,
        mediaMetadata: { title: 'Dune', subtitle: null, author: 'Frank Herbert' },
        lastUpdate: lastUpdate.getTime(),
      },
    });
    expect(stats.days).toEqual({ '2026-03-02': 1200 });
    expect(stats.dayOfWeek).toEqual({ Monday: 1200 });
    expect(stats.recentSessions).toHaveLength(1);
  });
});

describe('readDeviceId', () => {
  it.each([
    [{ deviceId: 'dev-1', id: 'other' }, 'dev-1'],
    [{ id: 'legacy-id' }, 'legacy-id'],
    [{ deviceId: '' }, null],
    [null, null],
    ['string', null],
  ])('reads %j as %s', (input, expected) => {
    expect(readDeviceId(input)).toBe(expected);
  });
});
