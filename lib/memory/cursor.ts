/**
 * Opaque keyset cursor over a `(createdAt, id)` ordering, newest first.
 *
 * Keyset rather than offset: pages stay correct when rows are inserted or
 * deleted between requests, and the query uses the same index every time
 * instead of scanning past a growing offset. `id` breaks ties so two rows
 * sharing a timestamp can never straddle a page boundary.
 */
export type PageCursor = { createdAt: number; id: string }

export const DEFAULT_PAGE_LIMIT = 50
export const MAX_PAGE_LIMIT = 100

/** Clamp a caller-supplied limit into a sane range. */
export function clampPageLimit(n: number | undefined, fallback = DEFAULT_PAGE_LIMIT): number {
  if (n === undefined || !Number.isFinite(n)) return fallback
  return Math.min(Math.max(Math.trunc(n), 1), MAX_PAGE_LIMIT)
}

export function encodeCursor(cursor: PageCursor): string {
  return Buffer.from(`${cursor.createdAt}:${cursor.id}`, 'utf8').toString('base64url')
}

/** Decodes a cursor, returning null for anything malformed so a bad cursor just starts from the top. */
export function decodeCursor(raw: string | null | undefined): PageCursor | null {
  if (!raw) return null
  try {
    const text = Buffer.from(raw, 'base64url').toString('utf8')
    const sep = text.indexOf(':')
    if (sep === -1) return null
    const createdAt = Number(text.slice(0, sep))
    const id = text.slice(sep + 1)
    if (!Number.isFinite(createdAt) || id.length === 0) return null
    return { createdAt, id }
  } catch {
    return null
  }
}

/**
 * Given one extra row was fetched beyond `limit`, split a result set into the
 * page to return and the cursor for the next one. `keyOf` pulls the ordering
 * key from the last kept row.
 */
export function paginate<T>(
  rows: T[],
  limit: number,
  keyOf: (row: T) => PageCursor,
): { items: T[]; nextCursor: string | null } {
  const hasMore = rows.length > limit
  const items = hasMore ? rows.slice(0, limit) : rows
  const last = items[items.length - 1]
  const nextCursor = hasMore && last ? encodeCursor(keyOf(last)) : null
  return { items, nextCursor }
}
