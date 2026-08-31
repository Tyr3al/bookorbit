import { describe, expect, it } from 'vitest';

import { fromAbsSeriesUuid, fromAbsUuid, toAbsSeriesUuid, toAbsUuid } from './abs-id.utils';

describe('Audiobookshelf ids', () => {
  it('keeps series ids distinct from other entity ids with the same database key', () => {
    expect(toAbsSeriesUuid(1)).not.toBe(toAbsUuid(1));
    expect(toAbsSeriesUuid(1)).toBe('00000001-0000-4000-8000-000000000001');
  });

  it('round-trips namespaced series ids', () => {
    expect(fromAbsSeriesUuid(toAbsSeriesUuid(42))).toBe(42);
    expect(fromAbsUuid(toAbsSeriesUuid(42))).toBeNull();
  });

  it('accepts legacy series ids for saved client links', () => {
    expect(fromAbsSeriesUuid(toAbsUuid(42))).toBe(42);
  });
});
