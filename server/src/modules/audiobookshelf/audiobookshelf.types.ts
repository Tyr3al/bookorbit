/**
 * Payload shapes of the Audiobookshelf-compatible API, following the ABS conventions:
 * camelCase field names, epoch-millisecond integer timestamps, string ids.
 * These types are server-only (Prologue is an external client), so they live in the
 * audiobookshelf module rather than in packages/types.
 */

export interface AbsFileMetadata {
  filename: string;
  ext: string;
  path: string;
  relPath: string;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
}

export interface AbsChapter {
  id: number;
  start: number;
  end: number;
  title: string;
}

export interface AbsAudioFile {
  index: number;
  ino: string;
  metadata: AbsFileMetadata;
  addedAt: number;
  updatedAt: number;
  trackNumFromMeta: number | null;
  discNumFromMeta: number | null;
  trackNumFromFilename: number | null;
  discNumFromFilename: number | null;
  manuallyVerified: boolean;
  exclude: boolean;
  error: string | null;
  format: string;
  duration: number | null;
  bitRate: number;
  language: string | null;
  codec: string;
  timeBase: string;
  channels: number;
  channelLayout: string;
  chapters: AbsChapter[];
  embeddedCoverArt: string | null;
  metaTags: Record<string, unknown>;
  mimeType: string;
}

/** Real ABS's track objects carry every AbsAudioFile field plus playback-specific ones - not
 * the leaner shape we originally guessed. */
export interface AbsTrack extends AbsAudioFile {
  title: string;
  startOffset: number;
  contentUrl: string;
}

export interface AbsLibraryFile {
  ino: string;
  metadata: AbsFileMetadata;
  addedAt: number;
  updatedAt: number;
  fileType: 'audio' | 'image' | 'ebook' | 'metadata' | 'text' | 'unknown';
  isSupplementary: boolean | null;
}

export interface AbsBookMetadata {
  title: string;
  titleIgnorePrefix: string;
  subtitle: string | null;
  authors: { id: string; name: string }[];
  narrators: string[];
  series: { id: string; name: string; sequence: string | null }[];
  genres: string[];
  publishedYear: string | null;
  publishedDate: string | null;
  publisher: string | null;
  description: string | null;
  descriptionPlain: string | null;
  isbn: string | null;
  asin: string | null;
  language: string | null;
  explicit: boolean;
  abridged: boolean;
  authorName: string;
  authorNameLF: string;
  narratorName: string;
  seriesName: string;
}

export interface AbsBookMedia {
  id: string;
  libraryItemId: string;
  metadata: AbsBookMetadata;
  coverPath: string | null;
  tags: string[];
  audioFiles: AbsAudioFile[];
  chapters: AbsChapter[];
  numTracks: number;
  numAudioFiles: number;
  numChapters: number;
  duration: number | null;
  size: number;
  tracks: AbsTrack[];
  ebookFile: null;
}

/** Real ABS's book metadata as returned inside a minified (list/search) library item. */
export interface AbsBookMetadataMinified {
  title: string;
  titleIgnorePrefix: string;
  subtitle: string | null;
  authorName: string;
  authorNameLF: string;
  narratorName: string;
  seriesName: string;
  genres: string[];
  publishedYear: string | null;
  publishedDate: string | null;
  publisher: string | null;
  description: string | null;
  isbn: string | null;
  asin: string | null;
  language: string | null;
  explicit: boolean;
  abridged: boolean;
}

/** Real ABS's book media as returned inside a minified (list/search) library item - no
 * per-file/track/chapter detail, no author/narrator/series id lists. */
export interface AbsBookMediaMinified {
  id: string;
  metadata: AbsBookMetadataMinified;
  coverPath: string | null;
  tags: string[];
  numTracks: number;
  numAudioFiles: number;
  numChapters: number;
  duration: number | null;
  size: number;
}

/** Real ABS's minified LibraryItem shape, used for paginated list/search results. The full
 * AbsLibraryItem (with audioFiles/tracks/chapters) is reserved for `GET /api/items/:id`. */
export interface AbsLibraryItemMinified {
  id: string;
  ino: string;
  oldLibraryItemId: string | null;
  libraryId: string;
  folderId: string;
  path: string;
  relPath: string;
  isFile: boolean;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
  addedAt: number;
  updatedAt: number;
  isMissing: boolean;
  isInvalid: boolean;
  mediaType: 'book';
  media: AbsBookMediaMinified;
  numFiles: number;
  size: number;
}

export interface AbsLibraryItem {
  id: string;
  ino: string;
  oldLibraryItemId: string | null;
  libraryId: string;
  folderId: string;
  path: string;
  relPath: string;
  isFile: boolean;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
  addedAt: number;
  updatedAt: number;
  lastScan: number;
  scanVersion: string;
  isMissing: boolean;
  isInvalid: boolean;
  mediaType: 'book';
  media: AbsBookMedia;
  libraryFiles: AbsLibraryFile[];
  numFiles: number;
  size: number;
  /** Present (and populated) only when the request includes `include=progress`. */
  userMediaProgress?: AbsMediaProgress | null;
}

export interface AbsLibraryFolder {
  id: string;
  fullPath: string;
  libraryId: string;
  addedAt: number;
}

export interface AbsLibrary {
  id: string;
  name: string;
  folders: AbsLibraryFolder[];
  displayOrder: number;
  icon: string | null;
  mediaType: 'book';
  provider: string;
  settings: {
    coverAspectRatio: number;
    disableWatcher: boolean;
    autoScanCronExpression: string | null;
    skipMatchingMediaWithAsin: boolean;
    skipMatchingMediaWithIsbn: boolean;
    audiobooksOnly: boolean;
    epubsAllowScriptedContent: boolean;
    hideSingleBookSeries: boolean;
    onlyShowLaterBooksInContinueSeries: boolean;
    metadataPrecedence: string[];
    markAsFinishedPercentComplete: number | null;
    markAsFinishedTimeRemaining: number;
  };
  lastScan: number;
  lastScanVersion: string;
  createdAt: number;
  lastUpdate: number;
}

export interface AbsMediaProgress {
  id: string;
  userId?: string | null;
  libraryItemId: string;
  episodeId?: string | null;
  mediaItemId: string;
  mediaItemType: 'book';
  duration: number | null;
  progress: number;
  currentTime: number;
  isFinished: boolean;
  hideFromContinueListening?: boolean;
  startedAt: number | null;
  lastUpdate: number | null;
  createdAt: number | null;
  updatedAt: number | null;
  finishedAt?: number | null;
  ebookLocation: string | null;
  ebookProgress: number | null;
}

export interface AbsPermissions {
  download: boolean;
  update: boolean;
  delete: boolean;
  upload: boolean;
  createEreader: boolean;
  accessAllLibraries: boolean;
  accessAllTags: boolean;
  accessExplicitContent: boolean;
  selectedTagsNotAccessible: boolean;
}

export interface AbsUser {
  id: string;
  username: string;
  email: string;
  type: 'root' | 'admin' | 'user' | 'guest';
  token: string;
  accessToken: string;
  refreshToken: string | null;
  mediaProgress: AbsMediaProgress[];
  seriesHideFromContinueListening: unknown[];
  bookmarks: unknown[];
  permissions: AbsPermissions;
  isActive: boolean;
  isLocked: boolean;
  lastSeen: number | null;
  createdAt: number;
  librariesAccessible: unknown[];
  itemTagsSelected: unknown[];
  hasOpenIDLink: boolean;
}

export interface AbsLoginResponse {
  user: AbsUser;
  userDefaultLibraryId: string | null;
  serverSettings: Record<string, unknown>;
  ereaderDevices?: unknown[];
  Source?: string;
}

export interface AbsAuthor {
  id: string;
  asin: string | null;
  name: string;
  description: string | null;
  imagePath: string | null;
  addedAt: number;
  updatedAt: number;
  libraryId?: string;
  numBooks?: number;
  lastFirst?: string | null;
}

export interface AbsAuthorExpanded extends AbsAuthor {
  libraryItems: AbsLibraryItemMinified[];
  series: { id: string; name: string; items: AbsLibraryItemMinified[] }[];
}

export interface AbsSeries {
  id: string;
  name: string;
  nameIgnorePrefix: string;
  description: string | null;
  addedAt: number;
  updatedAt: number;
  libraryId?: string;
}

// Real ABS's single-series detail fetch (GET /api/series/:id and
// GET /api/libraries/:id/series/:seriesId) never embeds books, even with `include=items` - it's
// just AbsSeries. Only the library-scoped series *list* embeds books (see AbsSeriesListItem).

// The library-scoped series list embeds each series' minified books directly in the row.
export interface AbsSeriesListItem extends AbsSeries {
  books: AbsLibraryItemMinified[];
}

export interface AbsCollection {
  id: string;
  libraryId: string;
  name: string;
  description: string | null;
  // Real ABS collections carry full expanded items here (audioFiles/tracks/chapters and all),
  // unlike the minified shape used by list/search endpoints.
  books: AbsLibraryItem[];
  lastUpdate: number;
  createdAt: number;
}

export interface AbsPaginatedItems {
  results: AbsLibraryItemMinified[];
  total: number;
  limit: number;
  page: number;
  sortBy?: string;
  sortDesc: boolean;
  filterBy?: string;
  mediaType: 'book';
  minified: boolean;
  collapseseries: boolean;
  include: string;
  offset: number;
}

export interface AbsPaginatedAuthors {
  results: AbsAuthor[];
  total: number;
  limit: number;
  page: number;
  sortDesc: boolean;
  minified: boolean;
}

// Narrators aren't real entities in ABS - id is the base64-encoded, URI-encoded name, present
// only so a client can drop it straight into filter=narrators.<id>.
export interface AbsNarrator {
  id: string;
  name: string;
  numBooks: number;
}

export interface AbsLibraryNarrators {
  narrators: AbsNarrator[];
}

// GET /api/libraries/:id/filterdata - a library's capability summary. Some ABS clients
// (confirmed with Prologue) check this before deciding what to sync/display persistently, so an
// unimplemented endpoint here can make a library look empty of series/genres/etc. even though
// the dedicated list endpoints work fine standalone.
export interface AbsLibraryFilterData {
  authors: { id: string; name: string }[];
  genres: string[];
  tags: string[];
  series: { id: string; name: string }[];
  narrators: string[];
  languages: string[];
  publishers: string[];
  publishedDecades: string[];
  bookCount: number;
  authorCount: number;
  seriesCount: number;
  podcastCount: number;
  numIssues: number;
  loadedAt: number;
}

export interface AbsPaginatedSeries {
  results: AbsSeriesListItem[];
  total: number;
  limit: number;
  page: number;
  sortBy: string;
  sortDesc: boolean;
  minified: boolean;
  include: string;
}

export interface AbsPaginatedCollections {
  results: AbsCollection[];
  total: number;
  limit: number;
  page: number;
  sortDesc: boolean;
  minified: boolean;
  include: string;
}

export interface AbsListeningSessions {
  total: number;
  numPages: number;
  page: number;
  itemsPerPage: number;
  sessions: unknown[];
}
