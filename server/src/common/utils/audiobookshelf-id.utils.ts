/**
 * Real Audiobookshelf servers key every entity (users, libraries, items, files, ...) with a real
 * UUID, and ABS clients (e.g. Prologue) rely on that shape - they decode JWT claims and response
 * ids as UUIDs. BookOrbit's primary keys are integers, so ids exposed through the
 * Audiobookshelf-compatible API are formatted as syntactically valid, stable, reversible v4-shaped
 * UUIDs instead of the raw integer, to match what those clients expect.
 */

const AUDIOBOOKSHELF_UUID_PATTERN = /^00000000-0000-4000-8000-([0-9a-f]{12})$/;
const AUDIOBOOKSHELF_SERIES_UUID_PATTERN = /^00000001-0000-4000-8000-([0-9a-f]{12})$/;
const AUDIOBOOKSHELF_COMPOSITE_UUID_PATTERN = /^00000000-0000-4000-8000-([0-9a-f]{12})$/;

export function toAudiobookshelfUuid(id: number): string {
  const hex = id.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}`;
}

export function fromAudiobookshelfUuid(uuid: string): number | null {
  const match = AUDIOBOOKSHELF_UUID_PATTERN.exec(uuid);
  if (!match) return null;
  return Number.parseInt(match[1], 16);
}

/**
 * Series and collections are displayed from one shared Prologue cache. Keep series ids in a
 * separate UUID namespace so equal integer primary keys cannot overwrite each other there.
 */
export function toAudiobookshelfSeriesUuid(id: number): string {
  const hex = id.toString(16).padStart(12, '0');
  return `00000001-0000-4000-8000-${hex}`;
}

export function fromAudiobookshelfSeriesUuid(uuid: string): number | null {
  const match = AUDIOBOOKSHELF_SERIES_UUID_PATTERN.exec(uuid);
  if (match) return Number.parseInt(match[1], 16);

  // Accept ids issued before series had a distinct namespace so saved links keep working.
  return fromAudiobookshelfUuid(uuid);
}

/** Composite UUID for records keyed by two ids (e.g. a mediaProgress row keyed by user+book). */
export function toAudiobookshelfCompositeUuid(a: number, b: number): string {
  const hexA = a.toString(16).padStart(6, '0').slice(-6);
  const hexB = b.toString(16).padStart(6, '0').slice(-6);
  return `00000000-0000-4000-8000-${hexA}${hexB}`;
}

export function fromAudiobookshelfCompositeUuid(uuid: string): { a: number; b: number } | null {
  const match = AUDIOBOOKSHELF_COMPOSITE_UUID_PATTERN.exec(uuid);
  if (!match) return null;
  const a = Number.parseInt(match[1].slice(0, 6), 16);
  if (a === 0) return null;
  return {
    a,
    b: Number.parseInt(match[1].slice(6), 16),
  };
}
