import { createHash } from 'node:crypto'
import type { StorageBackend } from '~/utils/checkpoint/storage'

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
