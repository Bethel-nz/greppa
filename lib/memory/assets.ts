import { createHash } from 'node:crypto'
import type { StorageBackend } from '~/utils/checkpoint/storage'

/**
 * Assets live outside the scope database because Checkpoint rewrites the whole
 * scope file on every write. A 20 MiB scope of screenshots would otherwise be
 * re-uploaded to add a 2 KB note — about 72 s on a 0.28 MiB/s uplink, growing
 * without bound. Content-addressed blobs are written once, deduplicated by
 * digest, and immutable, so they need no compare-and-set.
 */
export function assetKey(scopeId: string, sha256: string): string {
  return `scopes/${scopeId}/assets/${sha256}`
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export async function putAssetIfAbsent(
  storage: StorageBackend,
  scopeId: string,
  bytes: Uint8Array,
): Promise<string> {
  const digest = sha256Hex(bytes)
  const key = assetKey(scopeId, digest)
  if (await storage.head(key)) return digest
  try {
    await storage.putIfMatch(key, bytes, null)
  } catch (err) {
    // A concurrent writer won the race. Identical content means an identical
    // digest, so whatever landed is already the object we wanted.
    if (await storage.head(key)) return digest
    throw err
  }
  return digest
}

export async function getAsset(
  storage: StorageBackend,
  scopeId: string,
  sha256: string,
): Promise<Uint8Array | null> {
  const got = await storage.get(assetKey(scopeId, sha256))
  return got ? got.body : null
}
