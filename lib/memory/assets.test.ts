import { describe, expect, test } from 'bun:test'
import { MemoryStorage } from '~/utils/checkpoint/storage'
import { assetKey, getAsset, putAssetIfAbsent, sha256Hex } from './assets'

const bytes = (s: string) => new TextEncoder().encode(s)

describe('assets', () => {
  test('key is scoped and content-addressed', () => {
    expect(assetKey('s1', 'abc')).toBe('scopes/s1/assets/abc')
  })

  test('sha256Hex is stable and 64 hex characters', () => {
    const h = sha256Hex(bytes('hello'))
    expect(h).toMatch(/^[0-9a-f]{64}$/)
    expect(sha256Hex(bytes('hello'))).toBe(h)
  })

  test('stores an asset and returns its digest', async () => {
    const storage = new MemoryStorage()
    const digest = await putAssetIfAbsent(storage, 's1', bytes('image-bytes'))
    expect(await storage.head(assetKey('s1', digest))).not.toBeNull()
  })

  test('is idempotent: storing the same bytes twice uploads once', async () => {
    const storage = new MemoryStorage()
    await putAssetIfAbsent(storage, 's1', bytes('same'))
    const puts = storage.counts.put
    await putAssetIfAbsent(storage, 's1', bytes('same'))
    expect(storage.counts.put).toBe(puts)
  })

  test('round-trips the exact bytes', async () => {
    const storage = new MemoryStorage()
    const digest = await putAssetIfAbsent(storage, 's1', bytes('round trip payload'))
    expect(new TextDecoder().decode((await getAsset(storage, 's1', digest))!)).toBe('round trip payload')
  })

  test('returns null for a missing asset', async () => {
    expect(await getAsset(new MemoryStorage(), 's1', 'deadbeef')).toBeNull()
  })

  test('different scopes do not share asset keys', async () => {
    const storage = new MemoryStorage()
    const digest = await putAssetIfAbsent(storage, 's1', bytes('x'))
    expect(await getAsset(storage, 's2', digest)).toBeNull()
  })

  test('survives a concurrent writer that wins the race', async () => {
    const storage = new MemoryStorage()
    const payload = bytes('raced')
    const [a, b] = await Promise.all([
      putAssetIfAbsent(storage, 's1', payload),
      putAssetIfAbsent(storage, 's1', payload),
    ])
    expect(a).toBe(b)
    expect((await storage.list('scopes/s1/assets/')).length).toBe(1)
  })
})
