/** Real ABS list-endpoint filters arrive as `filter=<category>.<base64(value)>` - every
 * category (including `missing`/`progress`) base64-encodes its value, e.g.
 * `missing.authors` is sent as `filter=missing.YXV0aG9ycw==`. */
export interface AbsItemFilter {
  category: string;
  value: string;
}

export function parseAbsItemFilter(filter: string | undefined): AbsItemFilter | null {
  if (!filter) return null;
  const separatorIndex = filter.indexOf('.');
  if (separatorIndex === -1) return null;
  const category = filter.slice(0, separatorIndex);
  const encoded = filter.slice(separatorIndex + 1);
  if (!category || !encoded) return null;

  try {
    return { category, value: Buffer.from(encoded, 'base64').toString('utf-8') };
  } catch {
    return null;
  }
}
