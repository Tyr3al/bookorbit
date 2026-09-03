/**
 * Payload shapes of the Audiobookshelf-compatible API, following the ABS conventions:
 * camelCase field names, epoch-millisecond integer timestamps, string ids.
 * These types are server-only (Prologue is an external client), so they live in the
 * audiobookshelf module rather than in packages/types.
 */

export interface AudiobookshelfFileMetadata {
  filename: string;
  ext: string;
  path: string;
  relPath: string;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
}

export interface AudiobookshelfChapter {
  id: number;
  start: number;
  end: number;
  title: string;
}

export interface AudiobookshelfAudioFile {
  index: number;
  ino: string;
  metadata: AudiobookshelfFileMetadata;
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
  chapters: AudiobookshelfChapter[];
  embeddedCoverArt: string | null;
  metaTags: Record<string, unknown>;
  mimeType: string;
}

/** Real ABS's track objects carry every AudiobookshelfAudioFile field plus playback-specific ones - not
 * the leaner shape we originally guessed. */
export interface AudiobookshelfTrack extends AudiobookshelfAudioFile {
  title: string;
  startOffset: number;
  contentUrl: string;
}

export interface AudiobookshelfLibraryFile {
  ino: string;
  metadata: AudiobookshelfFileMetadata;
  addedAt: number;
  updatedAt: number;
  fileType: 'audio' | 'image' | 'ebook' | 'metadata' | 'text' | 'unknown';
  isSupplementary: boolean | null;
}

export interface AudiobookshelfBookMetadata {
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

export interface AudiobookshelfBookMedia {
  id: string;
  libraryItemId: string;
  metadata: AudiobookshelfBookMetadata;
  coverPath: string | null;
  tags: string[];
  audioFiles: AudiobookshelfAudioFile[];
  chapters: AudiobookshelfChapter[];
  numTracks: number;
  numAudioFiles: number;
  numChapters: number;
  duration: number | null;
  size: number;
  tracks: AudiobookshelfTrack[];
  ebookFile: null;
}

/** Real ABS's book metadata as returned inside a minified (list/search) library item. */
export interface AudiobookshelfBookMetadataMinified {
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
export interface AudiobookshelfBookMediaMinified {
  id: string;
  metadata: AudiobookshelfBookMetadataMinified;
  coverPath: string | null;
  tags: string[];
  numTracks: number;
  numAudioFiles: number;
  numChapters: number;
  duration: number | null;
  size: number;
}

/** Real ABS's minified LibraryItem shape, used for paginated list/search results. The full
 * AudiobookshelfLibraryItem (with audioFiles/tracks/chapters) is reserved for `GET /api/items/:id`. */
export interface AudiobookshelfLibraryItemMinified {
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
  media: AudiobookshelfBookMediaMinified;
  numFiles: number;
  size: number;
}

export interface AudiobookshelfLibraryItem {
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
  media: AudiobookshelfBookMedia;
  libraryFiles: AudiobookshelfLibraryFile[];
  numFiles: number;
  size: number;
  /** Present (and populated) only when the request includes `include=progress`. */
  userMediaProgress?: AudiobookshelfMediaProgress | null;
}

export interface AudiobookshelfLibraryFolder {
  id: string;
  fullPath: string;
  libraryId: string;
  addedAt: number;
}

export interface AudiobookshelfLibrary {
  id: string;
  name: string;
  folders: AudiobookshelfLibraryFolder[];
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

export interface AudiobookshelfMediaProgress {
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

export interface AudiobookshelfPermissions {
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

export interface AudiobookshelfUser {
  id: string;
  username: string;
  email: string;
  type: 'root' | 'admin' | 'user' | 'guest';
  token: string;
  accessToken: string;
  refreshToken: string | null;
  mediaProgress: AudiobookshelfMediaProgress[];
  seriesHideFromContinueListening: unknown[];
  bookmarks: unknown[];
  permissions: AudiobookshelfPermissions;
  isActive: boolean;
  isLocked: boolean;
  lastSeen: number | null;
  createdAt: number;
  librariesAccessible: unknown[];
  itemTagsSelected: unknown[];
  hasOpenIDLink: boolean;
}

export interface AudiobookshelfLoginResponse {
  user: AudiobookshelfUser;
  userDefaultLibraryId: string | null;
  serverSettings: Record<string, unknown>;
  ereaderDevices?: unknown[];
  Source?: string;
}

export interface AudiobookshelfAuthor {
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

export interface AudiobookshelfAuthorExpanded extends AudiobookshelfAuthor {
  libraryItems: AudiobookshelfLibraryItemMinified[];
  series: { id: string; name: string; items: AudiobookshelfLibraryItemMinified[] }[];
}

// Sort values accepted by the library-scoped series list (GET /api/libraries/:id/series).
export type AudiobookshelfSeriesSort = 'name' | 'addedAt' | 'updatedAt' | 'numBooks' | 'lastBookUpdated';

export interface AudiobookshelfSeries {
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
// just AudiobookshelfSeries. Only the library-scoped series *list* embeds books; each row below
// carries its series' minified books directly in `books`.
export interface AudiobookshelfSeriesListItem extends AudiobookshelfSeries {
  books: AudiobookshelfLibraryItemMinified[];
}

export interface AudiobookshelfCollection {
  id: string;
  libraryId: string;
  name: string;
  description: string | null;
  // Real ABS collections carry full expanded items here (audioFiles/tracks/chapters and all),
  // unlike the minified shape used by list/search endpoints.
  books: AudiobookshelfLibraryItem[];
  lastUpdate: number;
  createdAt: number;
}

export interface AudiobookshelfPaginatedItems {
  results: AudiobookshelfLibraryItemMinified[];
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

export interface AudiobookshelfPersonalizedShelf {
  id: string;
  label: string;
  labelStringKey: 'LabelContinueListening' | 'LabelRecentlyAdded';
  type: 'book';
  entities: (AudiobookshelfLibraryItemMinified & { progressLastUpdate?: number })[];
  total: number;
}

export interface AudiobookshelfPaginatedAuthors {
  results: AudiobookshelfAuthor[];
  total: number;
  limit: number;
  page: number;
  sortBy: string;
  sortDesc: boolean;
  filterBy?: string;
  minified: boolean;
  include: string;
}

// Narrators aren't real entities in ABS - id is the base64-encoded, URI-encoded name, present
// only so a client can drop it straight into filter=narrators.<id>.
export interface AudiobookshelfNarrator {
  id: string;
  name: string;
  numBooks: number;
}

export interface AudiobookshelfLibraryNarrators {
  narrators: AudiobookshelfNarrator[];
}

// GET /api/libraries/:id/filterdata - a library's capability summary. Some ABS clients
// (confirmed with Prologue) check this before deciding what to sync/display persistently, so an
// unimplemented endpoint here can make a library look empty of series/genres/etc. even though
// the dedicated list endpoints work fine standalone.
export interface AudiobookshelfLibraryFilterData {
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

export interface AudiobookshelfPaginatedSeries {
  results: AudiobookshelfSeriesListItem[];
  total: number;
  limit: number;
  page: number;
  sortBy: string;
  sortDesc: boolean;
  minified: boolean;
  include: string;
}

export interface AudiobookshelfPaginatedCollections {
  results: AudiobookshelfCollection[];
  total: number;
  limit: number;
  page: number;
  sortDesc: boolean;
  minified: boolean;
  include: string;
}

export interface AudiobookshelfListeningSessions {
  total: number;
  numPages: number;
  page: number;
  itemsPerPage: number;
  sessions: unknown[];
}

/** Expanded response returned when a client starts direct playback for a book. */
export interface AudiobookshelfPlaybackSessionExpanded {
  id: string;
  userId: string;
  libraryId: string;
  libraryItemId: string;
  bookId: string;
  episodeId: null;
  mediaType: 'book';
  mediaMetadata: Record<string, unknown>;
  chapters: AudiobookshelfChapter[];
  displayTitle: string;
  displayAuthor: string;
  coverPath: string | null;
  duration: number | null;
  playMethod: 0;
  mediaPlayer: string;
  deviceInfo: Record<string, unknown> | null;
  serverVersion: string;
  date: string;
  dayOfWeek: string;
  timeListening: number;
  startTime: number;
  currentTime: number;
  startedAt: number;
  updatedAt: number;
  audioTracks: AudiobookshelfPlaybackAudioTrack[];
  libraryItem: AudiobookshelfLibraryItem;
}

/** Playback tracks intentionally omit server-only audio-file fields and paths. */
export interface AudiobookshelfPlaybackAudioTrack {
  index: number;
  startOffset: number;
  duration: number | null;
  title: string;
  contentUrl: string;
  mimeType: string;
  codec: string;
  metadata: AudiobookshelfFileMetadata;
}

/** A historical listening-session record, returned by the listening-sessions and
 * listening-stats read paths. Unlike AudiobookshelfPlaybackSessionExpanded, this is never the live
 * playback handle - see AudiobookshelfSessionsService. */
export interface AudiobookshelfPlaybackSession {
  id: string;
  userId: string;
  libraryId: string;
  libraryItemId: string;
  bookId: string;
  episodeId: null;
  mediaType: 'book';
  mediaMetadata: Record<string, unknown>;
  chapters: null;
  displayTitle: string;
  displayAuthor: string;
  coverPath: string | null;
  duration: number | null;
  playMethod: number;
  mediaPlayer: string;
  deviceInfo: Record<string, unknown> | null;
  serverVersion: string;
  date: string;
  dayOfWeek: string;
  timeListening: number;
  startTime: number;
  currentTime: number;
  startedAt: number;
  updatedAt: number;
}

export interface AudiobookshelfListeningSessionsEnvelope {
  total: number;
  numPages: number;
  page: number;
  itemsPerPage: number;
  sessions: AudiobookshelfPlaybackSession[];
}

export interface AudiobookshelfListeningStatsItem {
  id: string;
  timeListening: number;
  mediaMetadata: Record<string, unknown>;
  lastUpdate: number;
}

export interface AudiobookshelfListeningStats {
  totalTime: number;
  items: Record<string, AudiobookshelfListeningStatsItem>;
  days: Record<string, number>;
  dayOfWeek: Record<string, number>;
  today: number;
  recentSessions: AudiobookshelfPlaybackSession[];
}
