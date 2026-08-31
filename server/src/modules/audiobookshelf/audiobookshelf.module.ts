import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { BookModule } from '../book/book.module';
import { AuthorsModule } from '../authors/authors.module';
import { AppSettingsModule } from '../app-settings/app-settings.module';
import { BookmarkModule } from '../bookmark/bookmark.module';
import { UserModule } from '../user/user.module';
import { AudiobookshelfRepository } from './audiobookshelf.repository';
import { AudiobookshelfEnabledGuard } from './audiobookshelf-enabled.guard';
import { LoginController } from './controllers/login.controller';
import { AbsOAuthController } from './controllers/abs-oauth.controller';
import { StatusController } from './controllers/status.controller';
import { PingController } from './controllers/ping.controller';
import { AuthorizeController } from './controllers/authorize.controller';
import { MeController } from './controllers/me.controller';
import { LibrariesController } from './controllers/libraries.controller';
import { ItemsController } from './controllers/items.controller';
import { AuthorsController } from './controllers/authors.controller';
import { SeriesController } from './controllers/series.controller';
import { CollectionsController } from './controllers/collections.controller';
import { SessionController } from './controllers/session.controller';
import { LibraryItemMapperService } from './services/library-item-mapper.service';
import { AudiobookshelfAuthService } from './services/audiobookshelf-auth.service';
import { AudiobookshelfLibrariesService } from './services/audiobookshelf-libraries.service';
import { AudiobookshelfItemsService } from './services/audiobookshelf-items.service';
import { AudiobookshelfProgressService } from './services/audiobookshelf-progress.service';
import { AudiobookshelfBookmarksService } from './services/audiobookshelf-bookmarks.service';
import { AudiobookshelfStreamService } from './services/audiobookshelf-stream.service';
import { AudiobookshelfPlaybackService } from './services/audiobookshelf-playback.service';
import { AudiobookshelfAuthorsService } from './services/audiobookshelf-authors.service';
import { AudiobookshelfSeriesService } from './services/audiobookshelf-series.service';
import { AudiobookshelfCollectionsService } from './services/audiobookshelf-collections.service';
import { AudiobookshelfNarratorsService } from './services/audiobookshelf-narrators.service';
import { AbsOAuthStateStore } from './services/abs-oauth-state.store';
import { AbsRefreshRouteRegistrar } from './services/abs-refresh-route.registrar';

@Module({
  imports: [AuthModule, UserModule, BookModule, AuthorsModule, AppSettingsModule, BookmarkModule],
  controllers: [
    LoginController,
    AbsOAuthController,
    StatusController,
    PingController,
    AuthorizeController,
    MeController,
    LibrariesController,
    ItemsController,
    AuthorsController,
    SeriesController,
    CollectionsController,
    SessionController,
  ],
  providers: [
    AudiobookshelfRepository,
    LibraryItemMapperService,
    AudiobookshelfAuthService,
    AudiobookshelfLibrariesService,
    AudiobookshelfItemsService,
    AudiobookshelfProgressService,
    AudiobookshelfBookmarksService,
    AudiobookshelfStreamService,
    AudiobookshelfPlaybackService,
    AudiobookshelfAuthorsService,
    AudiobookshelfSeriesService,
    AudiobookshelfCollectionsService,
    AudiobookshelfNarratorsService,
    AbsOAuthStateStore,
    AbsRefreshRouteRegistrar,
    AudiobookshelfEnabledGuard,
  ],
})
export class AudiobookshelfModule {}
