import { describe, expect, it } from 'vitest';

import {
  fromAudiobookshelfCompositeUuid,
  fromAudiobookshelfSeriesUuid,
  fromAudiobookshelfUuid,
  toAudiobookshelfCompositeUuid,
  toAudiobookshelfSeriesUuid,
  toAudiobookshelfUuid,
} from './audiobookshelf-id.utils';

describe('Audiobookshelf ids', () => {
  it('keeps series ids distinct from other entity ids with the same database key', () => {
    expect(toAudiobookshelfSeriesUuid(1)).not.toBe(toAudiobookshelfUuid(1));
    expect(toAudiobookshelfSeriesUuid(1)).toBe('00000001-0000-4000-8000-000000000001');
  });

  it('round-trips namespaced series ids', () => {
    expect(fromAudiobookshelfSeriesUuid(toAudiobookshelfSeriesUuid(42))).toBe(42);
    expect(fromAudiobookshelfUuid(toAudiobookshelfSeriesUuid(42))).toBeNull();
  });

  it('accepts legacy series ids for saved client links', () => {
    expect(fromAudiobookshelfSeriesUuid(toAudiobookshelfUuid(42))).toBe(42);
  });

  it('round-trips composite progress ids', () => {
    expect(fromAudiobookshelfCompositeUuid(toAudiobookshelfCompositeUuid(12, 345))).toEqual({ a: 12, b: 345 });
    expect(fromAudiobookshelfCompositeUuid(toAudiobookshelfUuid(345))).toBeNull();
  });
});
