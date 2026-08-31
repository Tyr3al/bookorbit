import { Injectable, NotFoundException } from '@nestjs/common';

import { AudiobookshelfRepository } from '../audiobookshelf.repository';
import { AudiobookshelfItemsService } from './audiobookshelf-items.service';
import { AudiobookshelfLibrariesService } from './audiobookshelf-libraries.service';
import type { AbsCollection, AbsPaginatedCollections } from '../audiobookshelf.types';
import type { RequestUser } from '../../../common/types/request-user';
import { fromAbsUuid, toAbsUuid } from '../../../common/utils/abs-id.utils';

@Injectable()
export class AudiobookshelfCollectionsService {
  constructor(
    private readonly repository: AudiobookshelfRepository,
    private readonly itemsService: AudiobookshelfItemsService,
    private readonly librariesService: AudiobookshelfLibrariesService,
  ) {}

  /** GET /api/collections - the user's own collections, books filtered to exposed audio items. */
  async listCollections(user: RequestUser): Promise<{ collections: AbsCollection[] }> {
    const collections = await this.repository.findCollectionsByUserId(user.id);
    return { collections: await this.hydrate(user, collections) };
  }

  /** GET /api/libraries/:id/collections - the user's collections scoped to a library. */
  async listLibraryCollections(user: RequestUser, libraryId: number, limit = 5, page = 0): Promise<AbsPaginatedCollections> {
    await this.librariesService.requireExposedLibrary(user, libraryId);
    const { collections } = await this.listCollections(user);
    const offset = page * limit;
    return {
      results: collections.slice(offset, offset + limit),
      total: collections.length,
      limit,
      page,
      sortDesc: false,
      minified: false,
      include: '',
    };
  }

  /** GET /api/collections/:id - one of the user's collections. */
  async getCollection(user: RequestUser, collectionId: number): Promise<AbsCollection> {
    const collection = await this.repository.findCollectionById(collectionId);
    if (!collection || collection.userId !== user.id) throw new NotFoundException(`Collection ${collectionId} not found`);
    const [hydrated] = await this.hydrate(user, [collection]);
    return hydrated;
  }

  private async hydrate(
    user: RequestUser,
    collections: { id: number; name: string; description: string | null; createdAt: Date; updatedAt: Date }[],
  ): Promise<AbsCollection[]> {
    if (collections.length === 0) return [];

    const collectionIds = collections.map((collection) => collection.id);
    const links = await this.repository.findCollectionBookIdsByCollectionIds(collectionIds);

    const contentFilters = user.isSuperuser ? undefined : user.contentFilters;
    const libraryIds = await this.librariesService.getExposedLibraryIds(user);
    const exposedBookIds = new Set(await this.repository.findAudioBookIdsByLibraries(libraryIds, contentFilters));

    const bookIds = links.filter((link) => exposedBookIds.has(link.bookId)).map((link) => link.bookId);
    const itemsById = new Map((await this.itemsService.getItemsByIds(bookIds)).map((item) => [fromAbsUuid(item.id), item]));

    const byCollectionId = new Map<number, typeof links>();
    for (const link of links) {
      if (!exposedBookIds.has(link.bookId)) continue;
      const list = byCollectionId.get(link.collectionId);
      if (list) list.push(link);
      else byCollectionId.set(link.collectionId, [link]);
    }

    const defaultLibraryId = libraryIds[0] !== undefined ? toAbsUuid(libraryIds[0]) : '';

    return collections.map((collection) => {
      const books = (byCollectionId.get(collection.id) ?? [])
        .map((link) => itemsById.get(link.bookId))
        .filter((item): item is NonNullable<typeof item> => item != null);
      return {
        id: toAbsUuid(collection.id),
        // Real ABS collections belong to exactly one library; BookOrbit's don't, so the
        // library of the collection's own books stands in (falling back to the user's first
        // exposed library for an empty collection).
        libraryId: books[0]?.libraryId ?? defaultLibraryId,
        name: collection.name,
        description: collection.description,
        books,
        lastUpdate: collection.updatedAt.getTime(),
        createdAt: collection.createdAt.getTime(),
      };
    });
  }
}
