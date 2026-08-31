import { describe, expect, it, vi } from 'vitest';

import type { RequestUser } from '../../../common/types/request-user';
import { LibrariesController } from './libraries.controller';

const user = { id: 7, isSuperuser: false } as RequestUser;

describe('LibrariesController', () => {
  it('passes personalized shelf query parameters to the service', async () => {
    const personalized = vi.fn().mockResolvedValue([{ id: 'recently-added' }]);
    const controller = new LibrariesController({ getPersonalized: personalized } as never, {} as never, {} as never, {} as never, {} as never);

    await expect(controller.personalized(user, '3', '25')).resolves.toEqual([{ id: 'recently-added' }]);
    expect(personalized).toHaveBeenCalledWith(user, 3, 25);
  });
});
