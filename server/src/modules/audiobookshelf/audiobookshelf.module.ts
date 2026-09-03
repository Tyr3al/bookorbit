import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { BookModule } from '../book/book.module';
import { AuthorsModule } from '../authors/authors.module';
import { AppSettingsModule } from '../app-settings/app-settings.module';
import { BookmarkModule } from '../bookmark/bookmark.module';
import { UserModule } from '../user/user.module';
import { AudiobookshelfRepository } from './audiobookshelf.repository';
import { AudiobookshelfEnabledGuard } from './audiobookshelf-enabled.guard';
import { AudiobookshelfLoginController } from './controllers/audiobookshelf-login.controller';
import { AudiobookshelfOAuthController } from './controllers/audiobookshelf-oauth.controller';
import { AudiobookshelfStatusController } from './controllers/audiobookshelf-status.controller';
import { AudiobookshelfPingController } from './controllers/audiobookshelf-ping.controller';
import { AudiobookshelfAuthorizeController } from './controllers/audiobookshelf-authorize.controller';
import { AudiobookshelfMeController } from './controllers/audiobookshelf-me.controller';
import { AudiobookshelfLibrariesController } from './controllers/audiobookshelf-libraries.controller';
import { AudiobookshelfItemsController } from './controllers/audiobookshelf-items.controller';
import { AudiobookshelfAuthorsController } from './controllers/audiobookshelf-authors.controller';
import { AudiobookshelfSeriesController } from './controllers/audiobookshelf-series.controller';
import { AudiobookshelfCollectionsController } from './controllers/audiobookshelf-collections.controller';
import { AudiobookshelfSessionController } from './controllers/audiobookshelf-session.controller';
import { AudiobookshelfPublicSessionController } from './controllers/audiobookshelf-public-session.controller';
import { AudiobookshelfLibraryItemMapperService } from './services/audiobookshelf-library-item-mapper.service';
import { AudiobookshelfAuthService } from './services/audiobookshelf-auth.service';
import { AudiobookshelfLibrariesService } from './services/audiobookshelf-libraries.service';
import { AudiobookshelfItemsService } from './services/audiobookshelf-items.service';
import { AudiobookshelfProgressService } from './services/audiobookshelf-progress.service';
import { AudiobookshelfBookmarksService } from './services/audiobookshelf-bookmarks.service';
import { AudiobookshelfStreamService } from './services/audiobookshelf-stream.service';
import { AudiobookshelfPlaybackService } from './services/audiobookshelf-playback.service';
import { AudiobookshelfOpenSessionStore } from './services/audiobookshelf-open-session.store';
import { AudiobookshelfAuthorsService } from './services/audiobookshelf-authors.service';
import { AudiobookshelfSeriesService } from './services/audiobookshelf-series.service';
import { AudiobookshelfCollectionsService } from './services/audiobookshelf-collections.service';
import { AudiobookshelfNarratorsService } from './services/audiobookshelf-narrators.service';
import { AudiobookshelfOAuthStateStore } from './services/audiobookshelf-oauth-state.store';
import { AudiobookshelfRefreshRouteRegistrar } from './services/audiobookshelf-refresh-route.registrar';
import { AudiobookshelfSessionsRepository } from './services/audiobookshelf-sessions.repository';
import { AudiobookshelfSessionsService } from './services/audiobookshelf-sessions.service';

@Module({
  imports: [AuthModule, UserModule, BookModule, AuthorsModule, AppSettingsModule, BookmarkModule],
  controllers: [
    AudiobookshelfLoginController,
    AudiobookshelfOAuthController,
    AudiobookshelfStatusController,
    AudiobookshelfPingController,
    AudiobookshelfAuthorizeController,
    AudiobookshelfMeController,
    AudiobookshelfLibrariesController,
    AudiobookshelfItemsController,
    AudiobookshelfAuthorsController,
    AudiobookshelfSeriesController,
    AudiobookshelfCollectionsController,
    AudiobookshelfSessionController,
    AudiobookshelfPublicSessionController,
  ],
  providers: [
    AudiobookshelfRepository,
    AudiobookshelfLibraryItemMapperService,
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
    AudiobookshelfOAuthStateStore,
    AudiobookshelfRefreshRouteRegistrar,
    AudiobookshelfEnabledGuard,
    AudiobookshelfSessionsRepository,
    AudiobookshelfSessionsService,
    AudiobookshelfOpenSessionStore,
  ],
})
export class AudiobookshelfModule {}
