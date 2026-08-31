import { describe, expect, it, vi } from 'vitest';

import { AudiobookshelfRepository } from './audiobookshelf.repository';

function createQuery<T>(result: T) {
  const query = {
    from: vi.fn(),
    innerJoin: vi.fn(),
    where: vi.fn(),
    groupBy: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(),
    offset: vi.fn(),
    then: (resolve: (value: T) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve(result).then(resolve, reject),
  };
  for (const method of ['from', 'innerJoin', 'where', 'groupBy', 'orderBy', 'limit', 'offset'] as const) {
    query[method].mockReturnValue(query);
  }
  return query;
}

describe('AudiobookshelfRepository', () => {
  it('applies author ordering, limit, and offset in SQL and returns a separate total', async () => {
    const rows = [{ id: 4, name: 'Author', numBooks: 3 }];
    const pageQuery = createQuery(rows);
    const countQuery = createQuery([{ total: 12 }]);
    const db = { select: vi.fn().mockReturnValueOnce(pageQuery).mockReturnValueOnce(countQuery) };
    const repository = new AudiobookshelfRepository(db as never);

    await expect(repository.findAuthorsWithCountsByLibrariesPage([10], undefined, 25, 50, 'numBooks', true)).resolves.toEqual({
      rows,
      total: 12,
    });

    expect(pageQuery.orderBy).toHaveBeenCalledTimes(1);
    expect(pageQuery.orderBy.mock.calls[0]).toHaveLength(2);
    expect(pageQuery.limit).toHaveBeenCalledWith(25);
    expect(pageQuery.offset).toHaveBeenCalledWith(50);
    expect(countQuery.limit).not.toHaveBeenCalled();
  });
});
