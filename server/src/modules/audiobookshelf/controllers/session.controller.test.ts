import { describe, expect, it, vi } from 'vitest';
import { toAbsCompositeUuid } from '../../../common/utils/abs-id.utils';
import type { RequestUser } from '../../../common/types/request-user';
import type { AudiobookshelfProgressService } from '../services/audiobookshelf-progress.service';
import type { AudiobookshelfPlaybackService } from '../services/audiobookshelf-playback.service';
import { SessionController } from './session.controller';

function user(id = 7): RequestUser {
  return { id } as RequestUser;
}

function makeController() {
  const progressService = {} as AudiobookshelfProgressService;
  const playbackService = { sync: vi.fn().mockResolvedValue(undefined) } as unknown as AudiobookshelfPlaybackService;
  return { controller: new SessionController(progressService, playbackService), playbackService };
}

describe('SessionController.syncSession', () => {
  it('syncs playback fields through the progress service and returns plain OK', async () => {
    const { controller, playbackService } = makeController();
    const currentUser = user();

    await expect(
      controller.syncSession(currentUser, toAbsCompositeUuid(7, 42), {
        currentTime: 123.5,
        duration: 3600,
        timeListened: 45,
        updatedAt: 1_700_000_000_000,
        isFinished: false,
        clientOnlyField: 'ignored',
      }),
    ).resolves.toBe('OK');

    expect(playbackService.sync).toHaveBeenCalledWith(currentUser, toAbsCompositeUuid(7, 42), expect.objectContaining({ currentTime: 123.5 }));
  });
});
