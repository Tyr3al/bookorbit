import { AUDIO_FORMATS } from '../scanner/lib/classify';

export const ABS_AUDIO_FORMATS = [...AUDIO_FORMATS];

// The whole ABS-compat API is mounted under this prefix (via RouterModule in app.module.ts) so
// it can coexist with BookOrbit's own web app on the same origin, the same way a reverse proxy
// would front an OPDS feed at its own subpath. ABS clients (Prologue) support this because real
// Audiobookshelf servers support the same pattern behind a reverse proxy (ROUTER_BASE_PATH) - the
// user points the client at "https://host/abs" as the server address.
export const ABS_BASE_PATH = '/abs';

export const ABS_AUDIO_MIME_TYPES: Record<string, string> = {
  m4b: 'audio/mp4',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  opus: 'audio/ogg; codecs=opus',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
};

export function resolveAbsAudioMimeType(format: string | null): string | null {
  if (!format) return null;
  return ABS_AUDIO_MIME_TYPES[format.toLowerCase()] ?? null;
}

export const ABS_DEFAULT_ITEM_LIMIT = 10;
export const ABS_MAX_ITEM_LIMIT = 100;
export const ABS_DEFAULT_IN_PROGRESS_LIMIT = 25;
export const ABS_MAX_IN_PROGRESS_LIMIT = 100;

export const ABS_DEFAULT_SESSIONS_PAGE_SIZE = 10;
export const ABS_MAX_SESSIONS_PAGE_SIZE = 100;
export const ABS_RECENT_SESSIONS_LIMIT = 10;

// Matches the default library setting markAsFinishedPercentComplete = 98.
export const ABS_FINISHED_PROGRESS = 0.98;

// Real ABS's `library.provider` is a metadata-provider id from a fixed enum (google, itunes,
// openlibrary, audible, ...), not an arbitrary server name - a value outside that set (e.g. our
// own app name) fails client-side decoding for clients that model it as a strict enum.
export const ABS_PROVIDER = 'google';

// ABS clients (Prologue) may parse this as a semver to gate compatibility, so it must look like
// a real Audiobookshelf release rather than BookOrbit's own build label ("Local build" etc.).
export const ABS_SERVER_VERSION = '2.36.0';

// Real ABS's library.settings.metadataPrecedence always lists this exact fixed six-value set (in
// this order); BookOrbit's own metadata-source vocabulary doesn't map 1:1, and the field is purely
// informational for ABS clients, so just mirror the real ABS default rather than translate ours.
export const ABS_METADATA_PRECEDENCE = ['folderStructure', 'audioMetatags', 'nfoFile', 'txtFiles', 'opfFile', 'absMetadata'];
