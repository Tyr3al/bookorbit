import { describe, expect, it, vi } from 'vitest';

import { toAbsUuid } from '../../../common/utils/abs-id.utils';
import type { RequestUser } from '../../../common/types/request-user';
import type { AbsListeningSessionRow } from '../../../db/schema';
import { AudiobookshelfSessionsService, type RecordLocalSessionInput } from './audiobookshelf-sessions.service';
import type { AudiobookshelfSessionsRepository } from './audiobookshelf-sessions.repository';

function repository(): { [K in keyof AudiobookshelfSessionsRepository]: ReturnType<typeof vi.fn> } {
  return {
    upsertLiveSession: vi.fn().mockResolvedValue({}),
    accumulateLiveSession: vi.fn().mockResolvedValue(undefined),
    insertLocalSessions: vi.fn().mockResolvedValue(undefined),
    findPage: vi.fn().mockResolvedValue({ rows: [], total: 0 }),
    findPageForBook: vi.fn().mockResolvedValue({ rows: [], total: 0 }),
    findRecent: vi.fn().mockResolvedValue([]),
    findStatsAggregate: vi.fn().mockResolvedValue({ totals: { totalTime: 0, today: 0 }, days: [], dayOfWeek: [], items: [], itemMediaMetadata: [] }),
  };
}

function itemsService() {
  return { requireExposedBook: vi.fn().mockResolvedValue({ id: 7, libraryId: 3 }) };
}

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

function sessionRow(overrides: Partial<AbsListeningSessionRow> = {}): AbsListeningSessionRow {
  const base: AbsListeningSessionRow = {
    id: 11,
    userId: 7,
    bookId: 42,
    libraryId: 3,
    source: 'live',
    displayTitle: 'A Book',
    displayAuthor: 'An Author',
    coverPath: null,
    duration: 3600,
    playMethod: 0,
    mediaPlayer: 'AVPlayer',
    deviceInfo: null,
    serverVersion: '2.36.0',
    date: '2026-09-01',
    dayOfWeek: 'Tuesday',
    timeListening: 90,
    startTime: 0,
    currentTime: 45,
    mediaMetadata: { title: 'A Book' },
    startedAt: new Date('2026-09-01T09:00:00Z'),
    updatedAt: new Date('2026-09-01T10:00:00Z'),
  };
  return { ...base, ...overrides };
}

describe('AudiobookshelfSessionsService.recordLocalSessions', () => {
  it('clamps negative listening time and position and derives date fields per row', async () => {
    const repo = repository();
    const service = new AudiobookshelfSessionsService(repo as never, itemsService() as never);
    const now = new Date(2026, 8, 1, 12, 0, 0);

    const entry: RecordLocalSessionInput = {
      bookId: 42,
      libraryId: 3,
      displayTitle: 'A Book',
      displayAuthor: 'An Author',
      duration: 3600,
      mediaPlayer: 'AVPlayer',
      deviceInfo: null,
      timeListening: -30,
      currentTime: -12,
      startedAt: now,
      updatedAt: now,
    };
    await service.recordLocalSessions(7, [entry]);

    expect(repo.insertLocalSessions).toHaveBeenCalledWith([
      expect.objectContaining({
        userId: 7,
        bookId: 42,
        libraryId: 3,
        source: 'local',
        timeListening: 0,
        currentTime: 0,
        startTime: 0,
        date: '2026-09-01',
        dayOfWeek: 'Tuesday',
      }),
    ]);
  });

  it('skips an empty batch without touching the repository', async () => {
    const repo = repository();
    const service = new AudiobookshelfSessionsService(repo as never, itemsService() as never);

    await service.recordLocalSessions(7, []);

    expect(repo.insertLocalSessions).not.toHaveBeenCalled();
  });
});

describe('AudiobookshelfSessionsService.getSessionsPage', () => {
  it('bounds page size and page number and returns the upstream envelope', async () => {
    const repo = repository();
    vi.mocked(repo.findPage).mockResolvedValue({ rows: [sessionRow()], total: 3 });
    const service = new AudiobookshelfSessionsService(repo as never, itemsService() as never);

    const result = await service.getSessionsPage(user(), -2, 500);

    expect(repo.findPage).toHaveBeenCalledWith(7, 100, 0);
    expect(result).toEqual({
      total: 3,
      numPages: 1,
      page: 0,
      itemsPerPage: 100,
      sessions: [
        expect.objectContaining({
          id: toAbsUuid(11),
          libraryItemId: toAbsUuid(42),
          bookId: toAbsUuid(42),
          displayTitle: 'A Book',
          timeListening: 90,
          startedAt: Date.parse('2026-09-01T09:00:00Z'),
          updatedAt: Date.parse('2026-09-01T10:00:00Z'),
        }),
      ],
    });
  });

  it('defaults itemsPerPage to 10 and clamps a fractional page', async () => {
    const repo = repository();
    const service = new AudiobookshelfSessionsService(repo as never, itemsService() as never);

    await service.getSessionsPage(user(), 2.7, NaN);

    expect(repo.findPage).toHaveBeenCalledWith(7, 10, 20);
  });
});

describe('AudiobookshelfSessionsService.getListeningStats', () => {
  it('keys aggregates by ABS uuid and exposes epoch lastUpdate', async () => {
    const repo = repository();
    vi.mocked(repo.findStatsAggregate).mockResolvedValue({
      totals: { totalTime: 125, today: 75 },
      days: [{ date: '2026-09-01', seconds: 125 }],
      dayOfWeek: [{ dayOfWeek: 'Tuesday', seconds: 125 }],
      items: [{ bookId: 42, timeListening: 125, lastUpdate: new Date('2026-09-01T10:00:00Z') }],
      itemMediaMetadata: [{ bookId: 42, mediaMetadata: { title: 'A Book' } }],
    });
    vi.mocked(repo.findRecent).mockResolvedValue([sessionRow()]);
    const service = new AudiobookshelfSessionsService(repo as never, itemsService() as never);

    const stats = await service.getListeningStats(user());

    expect(stats.totalTime).toBe(125);
    expect(stats.today).toBe(75);
    expect(stats.days).toEqual({ '2026-09-01': 125 });
    expect(stats.dayOfWeek).toEqual({ Tuesday: 125 });
    expect(stats.items[toAbsUuid(42)]).toEqual({
      id: toAbsUuid(42),
      timeListening: 125,
      mediaMetadata: { title: 'A Book' },
      lastUpdate: Date.parse('2026-09-01T10:00:00Z'),
    });
    expect(stats.recentSessions).toHaveLength(1);
  });

  it('scopes the item route through the exposed-book check', async () => {
    const repo = repository();
    const items = itemsService();
    const service = new AudiobookshelfSessionsService(repo as never, items as never);

    await service.getItemSessionsPage(user(), 42, 0, 10);

    expect(items.requireExposedBook).toHaveBeenCalledWith(user(), 42);
    expect(repo.findPageForBook).toHaveBeenCalledWith(7, 42, 10, 0);
  });
});
