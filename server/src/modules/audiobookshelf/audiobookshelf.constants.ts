import { AUDIO_FORMATS } from '../scanner/lib/classify';

export const AUDIOBOOKSHELF_AUDIO_FORMATS = [...AUDIO_FORMATS];

export { AUDIOBOOKSHELF_BASE_PATH } from '../../common/constants/audiobookshelf.constants';

export const AUDIOBOOKSHELF_AUDIO_MIME_TYPES: Record<string, string> = {
  m4b: 'audio/mp4',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  opus: 'audio/ogg; codecs=opus',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
};

export function resolveAudiobookshelfAudioMimeType(format: string | null): string | null {
  if (!format) return null;
  return AUDIOBOOKSHELF_AUDIO_MIME_TYPES[format.toLowerCase()] ?? null;
}

export const AUDIOBOOKSHELF_DEFAULT_ITEM_LIMIT = 10;
export const AUDIOBOOKSHELF_MAX_ITEM_LIMIT = 100;
export const AUDIOBOOKSHELF_DEFAULT_IN_PROGRESS_LIMIT = 25;
export const AUDIOBOOKSHELF_MAX_IN_PROGRESS_LIMIT = 100;

export const AUDIOBOOKSHELF_DEFAULT_SESSIONS_PAGE_SIZE = 10;
export const AUDIOBOOKSHELF_MAX_SESSIONS_PAGE_SIZE = 100;
export const AUDIOBOOKSHELF_RECENT_SESSIONS_LIMIT = 10;

// Matches the default library setting markAsFinishedPercentComplete = 98.
export const AUDIOBOOKSHELF_FINISHED_PROGRESS = 0.98;

// Real ABS's `library.provider` is a metadata-provider id from a fixed enum (google, itunes,
// openlibrary, audible, ...), not an arbitrary server name - a value outside that set (e.g. our
// own app name) fails client-side decoding for clients that model it as a strict enum.
export const AUDIOBOOKSHELF_PROVIDER = 'google';

// ABS clients (Prologue) may parse this as a semver to gate compatibility, so it must look like
// a real Audiobookshelf release rather than BookOrbit's own build label ("Local build" etc.).
export const AUDIOBOOKSHELF_SERVER_VERSION = '2.36.0';
export const AUDIOBOOKSHELF_DEVICE_LABEL = 'Audiobookshelf client';

// Real ABS's library.settings.metadataPrecedence always lists this exact fixed six-value set (in
// this order); BookOrbit's own metadata-source vocabulary doesn't map 1:1, and the field is purely
// informational for ABS clients, so just mirror the real ABS default rather than translate ours.
export const AUDIOBOOKSHELF_METADATA_PRECEDENCE = ['folderStructure', 'audioMetatags', 'nfoFile', 'txtFiles', 'opfFile', 'absMetadata'];

/** Matches the web login throttle; only routes that declare @Throttle are rate limited. */
export const AUDIOBOOKSHELF_LOGIN_THROTTLE_LIMIT = 5;
export const AUDIOBOOKSHELF_LOGIN_THROTTLE_TTL_MS = 60_000;
