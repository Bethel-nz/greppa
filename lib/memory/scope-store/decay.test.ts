import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDeterministicProvider } from '../embedding/deterministic'
import { DECAY_OFF, decayConfigFromEnv, temporalWeight, type DecayConfig } from './decay'
import { hybridSearch, insertDocument, openScopeStore, recordAccess } from './store'

const DAY = 86_400_000
const on = (over: Partial<DecayConfig> = {}): DecayConfig =>
  ({ enabled: true, halfLifeDays: 30, floor: 0.25, ...over })

describe('temporalWeight', () => {
  const now = 1_000 * DAY

  test('disabled decay is always neutral', () => {
    expect(temporalWeight(0, now, DECAY_OFF)).toBe(1)
  })

  test('a brand new memory is at full strength', () => {
    expect(temporalWeight(now, now, on())).toBeCloseTo(1, 6)
  })

  test('one half-life lands halfway between floor and 1', () => {
    const w = temporalWeight(now - 30 * DAY, now, on({ halfLifeDays: 30, floor: 0 }))
    expect(w).toBeCloseTo(0.5, 4)
  })

  test('the floor is a lower bound no age can breach', () => {
    const w = temporalWeight(now - 10_000 * DAY, now, on({ floor: 0.25 }))
    expect(w).toBeGreaterThanOrEqual(0.25)
    expect(w).toBeCloseTo(0.25, 4)
  })

  test('decay is monotonic in age', () => {
    const cfg = on()
    const ages = [0, 1, 7, 30, 90, 365].map((d) => temporalWeight(now - d * DAY, now, cfg))
    for (let i = 1; i < ages.length; i++) expect(ages[i]!).toBeLessThan(ages[i - 1]!)
  })

  test('a future timestamp clamps to full strength rather than exceeding it', () => {
    expect(temporalWeight(now + 5 * DAY, now, on())).toBe(1)
  })
})

describe('decayConfigFromEnv', () => {
  test('is off unless explicitly enabled', () => {
    expect(decayConfigFromEnv({} as NodeJS.ProcessEnv).enabled).toBe(false)
  })

  test('reads half-life and floor', () => {
    const cfg = decayConfigFromEnv({
      MEMORY_DECAY_ENABLED: '1',
      MEMORY_DECAY_HALF_LIFE_DAYS: '7',
      MEMORY_DECAY_FLOOR: '0.1',
    } as NodeJS.ProcessEnv)
    expect(cfg).toEqual({ enabled: true, halfLifeDays: 7, floor: 0.1 })
  })

  test('rejects a nonsense floor rather than producing negative weights', () => {
    expect(decayConfigFromEnv({ MEMORY_DECAY_FLOOR: '5' } as NodeJS.ProcessEnv).floor).toBe(0.25)
    expect(decayConfigFromEnv({ MEMORY_DECAY_FLOOR: 'old' } as NodeJS.ProcessEnv).floor).toBe(0.25)
  })
})

describe('decay in retrieval', () => {
  const provider = createDeterministicProvider(128)
  const dirs: string[] = []
  const tmpPath = () => {
    const d = mkdtempSync(join(tmpdir(), 'decay-'))
    dirs.push(d)
    return join(d, 'm.sqlite')
  }
  const cleanup = () => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) }

  const seed = async (path: string) => {
    const store = openScopeStore(path, { provider, create: true })
    const text = 'shared vocabulary about quarterly planning'
    for (const title of ['old', 'new']) {
      const [embedding] = await provider.embed([text], 'document')
      insertDocument(store, { title, text, sourceType: 'note', createdBy: 'u1', chunks: [{ text, embedding: embedding! }] })
    }
    store.db.run("update chunks set created_at = ? where document_id = (select id from documents where title = 'old')", [Date.now() - 365 * DAY])
    return store
  }

  test('with decay off, age does not affect ranking', async () => {
    const store = await seed(tmpPath())
    const [qv] = await provider.embed(['quarterly planning'], 'query')
    const scores = hybridSearch(store, 'quarterly planning', qv!, 10)
    expect(new Set(scores.map((h) => h.score)).size).toBe(1) 
    store.close(); cleanup()
  })

  test('with decay on, the fresher memory outranks the stale one', async () => {
    const store = await seed(tmpPath())
    const [qv] = await provider.embed(['quarterly planning'], 'query')
    const hits = hybridSearch(store, 'quarterly planning', qv!, 10, undefined, on())
    expect(hits[0]!.title).toBe('new')
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score)
    store.close(); cleanup()
  })

  test('a stale memory is down-ranked, never removed', async () => {
    const store = await seed(tmpPath())
    const [qv] = await provider.embed(['quarterly planning'], 'query')
    const hits = hybridSearch(store, 'quarterly planning', qv!, 10, undefined, on({ floor: 0.01 }))
    expect(hits.map((h) => h.title).sort()).toEqual(['new', 'old'])
    store.close(); cleanup()
  })

  test('recordAccess reinforces a memory back to full strength', async () => {
    const path = tmpPath()
    const store = await seed(path)
    const [qv] = await provider.embed(['quarterly planning'], 'query')

    const before = hybridSearch(store, 'quarterly planning', qv!, 10, undefined, on())
    expect(before[0]!.title).toBe('new')

    const stale = before.find((h) => h.title === 'old')!
    recordAccess(store, [stale.chunkId])

    const after = hybridSearch(store, 'quarterly planning', qv!, 10, undefined, on())
    expect(after[0]!.title).toBe('old') 
    store.close(); cleanup()
  })

  test('access_count increments so reinforcement is observable', async () => {
    const store = await seed(tmpPath())
    const id = (store.db.prepare('select id from chunks limit 1').get() as { id: number }).id
    recordAccess(store, [id])
    recordAccess(store, [id])
    const row = store.db.prepare('select access_count from chunks where id = ?').get(id) as { access_count: number }
    expect(row.access_count).toBe(2)
    store.close(); cleanup()
  })
})
