import { describe, expect, it, vi } from 'vitest';

import { AudiobookshelfRepository } from './audiobookshelf.repository';

function createQuery<T>(result: T) {
  const query = {
    from: vi.fn(),
    innerJoin: vi.fn(),
    leftJoin: vi.fn(),
    where: vi.fn(),
    groupBy: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(),
    offset: vi.fn(),
    then: (resolve: (value: T) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve(result).then(resolve, reject),
  };
  for (const method of ['from', 'innerJoin', 'leftJoin', 'where', 'groupBy', 'orderBy', 'limit', 'offset'] as const) {
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

  it('folds derived addedAt/updatedAt aggregates into the author page query and results', async () => {
    const rows = [{ id: 4, name: 'Author', numBooks: 3, addedAt: new Date(1000), updatedAt: new Date(2000) }];
    const pageQuery = createQuery(rows);
    const countQuery = createQuery([{ total: 1 }]);
    const db = { select: vi.fn().mockReturnValueOnce(pageQuery).mockReturnValueOnce(countQuery) };
    const repository = new AudiobookshelfRepository(db as never);

    const result = await repository.findAuthorsWithCountsByLibrariesPage([10], undefined, 25, 0);

    expect(result.rows[0]).toMatchObject({ addedAt: new Date(1000), updatedAt: new Date(2000) });
    expect(db.select.mock.calls[0][0]).toEqual(expect.objectContaining({ addedAt: expect.anything(), updatedAt: expect.anything() }));
  });

  it('folds derived addedAt/updatedAt aggregates into the unpaginated author query', async () => {
    const rows = [{ id: 4, name: 'Author', numBooks: 3, addedAt: new Date(1000), updatedAt: new Date(2000) }];
    const query = createQuery(rows);
    const db = { select: vi.fn().mockReturnValue(query) };
    const repository = new AudiobookshelfRepository(db as never);

    const result = await repository.findAuthorsWithCountsByLibraries([10]);

    expect(result).toEqual(rows);
    expect(db.select.mock.calls[0][0]).toEqual(expect.objectContaining({ addedAt: expect.anything(), updatedAt: expect.anything() }));
  });

  it('derives one author addedAt/updatedAt via a single SQL aggregate query', async () => {
    const query = createQuery([{ addedAt: new Date(500), updatedAt: new Date(1500) }]);
    const db = { select: vi.fn().mockReturnValue(query) };
    const repository = new AudiobookshelfRepository(db as never);

    await expect(repository.findAuthorBookStatsByLibraries(3, [10])).resolves.toEqual({
      addedAt: new Date(500),
      updatedAt: new Date(1500),
    });
  });

  it('returns undefined from findAuthorBookStatsByLibraries when the author has no exposed books', async () => {
    const query = createQuery([{ addedAt: null, updatedAt: null }]);
    const db = { select: vi.fn().mockReturnValue(query) };
    const repository = new AudiobookshelfRepository(db as never);

    await expect(repository.findAuthorBookStatsByLibraries(3, [10])).resolves.toBeUndefined();
  });

  it('returns undefined for findAuthorBookStatsByLibraries with no libraries, without querying', async () => {
    const db = { select: vi.fn() };
    const repository = new AudiobookshelfRepository(db as never);

    await expect(repository.findAuthorBookStatsByLibraries(3, [])).resolves.toBeUndefined();
    expect(db.select).not.toHaveBeenCalled();
  });

  it('counts audio books across libraries in SQL without returning ids', async () => {
    const countQuery = createQuery([{ count: 42 }]);
    const db = { select: vi.fn().mockReturnValue(countQuery) };
    const repository = new AudiobookshelfRepository(db as never);

    await expect(repository.countAudioBooksByLibraries([10, 11])).resolves.toBe(42);
    expect(db.select).toHaveBeenCalledWith({ count: expect.anything() });
    expect(countQuery.limit).not.toHaveBeenCalled();
  });

  it('returns 0 for countAudioBooksByLibraries with no libraries, without querying', async () => {
    const db = { select: vi.fn() };
    const repository = new AudiobookshelfRepository(db as never);

    await expect(repository.countAudioBooksByLibraries([])).resolves.toBe(0);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('scopes findAuthorBookIdsByLibraries to one author and the given libraries', async () => {
    const rows = [{ id: 5 }, { id: 8 }];
    const query = createQuery(rows);
    const db = { select: vi.fn().mockReturnValue(query) };
    const repository = new AudiobookshelfRepository(db as never);

    await expect(repository.findAuthorBookIdsByLibraries(3, [10])).resolves.toEqual([5, 8]);
    expect(query.orderBy).toHaveBeenCalledTimes(1);
  });

  it('returns [] for findAuthorBookIdsByLibraries with no libraries, without querying', async () => {
    const db = { select: vi.fn() };
    const repository = new AudiobookshelfRepository(db as never);

    await expect(repository.findAuthorBookIdsByLibraries(3, [])).resolves.toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('bounds findAudioBookSearchIds with a SQL limit and returns only matching ids', async () => {
    const rows = [{ id: 9 }];
    const query = createQuery(rows);
    const db = { select: vi.fn().mockReturnValue(query) };
    const repository = new AudiobookshelfRepository(db as never);

    await expect(repository.findAudioBookSearchIds(3, 'dune', 12)).resolves.toEqual([9]);
    expect(query.limit).toHaveBeenCalledWith(12);
    expect(query.offset).not.toHaveBeenCalled();
    expect(query.leftJoin).toHaveBeenCalledTimes(1);
  });

  it('bounds findGenresWithCountsByLibraries and findTagsWithCountsByLibraries with a SQL limit', async () => {
    const genreQuery = createQuery([{ name: 'Fantasy', numItems: 3 }]);
    const tagQuery = createQuery([{ name: 'favorites', numItems: 2 }]);
    const db = { select: vi.fn().mockReturnValueOnce(genreQuery).mockReturnValueOnce(tagQuery) };
    const repository = new AudiobookshelfRepository(db as never);

    await expect(repository.findGenresWithCountsByLibraries([3], undefined, 'fan', 5)).resolves.toEqual([{ name: 'Fantasy', numItems: 3 }]);
    await expect(repository.findTagsWithCountsByLibraries([3], undefined, 'fav', 5)).resolves.toEqual([{ name: 'favorites', numItems: 2 }]);
    expect(genreQuery.limit).toHaveBeenCalledWith(5);
    expect(tagQuery.limit).toHaveBeenCalledWith(5);
  });

  it('applies a SQL limit to findNarratorsWithCountsByLibraries only when one is requested', async () => {
    const searchQuery = createQuery([{ id: 1, name: 'Jane', numBooks: 2 }]);
    const listQuery = createQuery([{ id: 1, name: 'Jane', numBooks: 2 }]);
    const db = { select: vi.fn().mockReturnValueOnce(searchQuery).mockReturnValueOnce(listQuery) };
    const repository = new AudiobookshelfRepository(db as never);

    await repository.findNarratorsWithCountsByLibraries([3], undefined, 'jan', 7);
    expect(searchQuery.limit).toHaveBeenCalledWith(7);

    await repository.findNarratorsWithCountsByLibraries([3], undefined);
    expect(listQuery.limit).not.toHaveBeenCalled();
  });

  it('filters findSeriesByLibrariesPage and findAuthorsWithCountsByLibrariesPage by an optional name', async () => {
    const seriesPageQuery = createQuery([{ id: 1, name: 'Dune Saga' }]);
    const seriesCountQuery = createQuery([{ total: 1 }]);
    const db = { select: vi.fn().mockReturnValueOnce(seriesPageQuery).mockReturnValueOnce(seriesCountQuery) };
    const repository = new AudiobookshelfRepository(db as never);

    await expect(repository.findSeriesByLibrariesPage([3], undefined, 12, 0, 'name', false, 'dune')).resolves.toEqual({
      rows: [{ id: 1, name: 'Dune Saga' }],
      total: 1,
    });
    expect(seriesPageQuery.limit).toHaveBeenCalledWith(12);
    expect(seriesPageQuery.offset).toHaveBeenCalledWith(0);
  });
});
