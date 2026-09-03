import { describe, expect, it, vi } from 'vitest';
import { toAudiobookshelfCompositeUuid } from '../../../common/utils/audiobookshelf-id.utils';
import type { RequestUser } from '../../../common/types/request-user';
import type { AudiobookshelfProgressService } from '../services/audiobookshelf-progress.service';
import type { AudiobookshelfPlaybackService } from '../services/audiobookshelf-playback.service';
import { AudiobookshelfSessionController } from './audiobookshelf-session.controller';

function user(id = 7): RequestUser {
  return { id } as RequestUser;
}

function makeController() {
  const progressService = {
    syncLocalSession: vi.fn().mockResolvedValue(undefined),
  } as unknown as AudiobookshelfProgressService;
  const playbackService = {
    sync: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as AudiobookshelfPlaybackService;
  return { controller: new AudiobookshelfSessionController(progressService, playbackService), playbackService, progressService };
}

describe('AudiobookshelfSessionController.syncLocalSession', () => {
  it('records one local session and returns plain OK', async () => {
    const { controller, progressService } = makeController();
    const currentUser = user();
    const body = { libraryItemId: 'item-id', currentTime: 123, extra: 'ignored' };

    await expect(controller.syncLocalSession(currentUser, body)).resolves.toBe('OK');
    expect(progressService.syncLocalSession).toHaveBeenCalledWith(currentUser, body);
  });
});

describe('AudiobookshelfSessionController.syncSession', () => {
  it('syncs playback fields through the progress service and returns plain OK', async () => {
    const { controller, playbackService } = makeController();
    const currentUser = user();

    await expect(
      controller.syncSession(currentUser, toAudiobookshelfCompositeUuid(7, 42), {
        currentTime: 123.5,
        duration: 3600,
        timeListened: 45,
        updatedAt: 1_700_000_000_000,
        isFinished: false,
        clientOnlyField: 'ignored',
      }),
    ).resolves.toBe('OK');

    expect(playbackService.sync).toHaveBeenCalledWith(
      currentUser,
      toAudiobookshelfCompositeUuid(7, 42),
      expect.objectContaining({ currentTime: 123.5 }),
    );
  });
});

describe('AudiobookshelfSessionController.closeSession', () => {
  it('closes a playback session and returns plain OK', async () => {
    const { controller, playbackService } = makeController();
    const currentUser = user();
    const sessionId = toAudiobookshelfCompositeUuid(7, 42);

    await expect(controller.closeSession(currentUser, sessionId, { currentTime: 123.5 })).resolves.toBe('OK');

    expect(playbackService.close).toHaveBeenCalledWith(currentUser, sessionId, { currentTime: 123.5 });
  });
});
