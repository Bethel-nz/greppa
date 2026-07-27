import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDeterministicProvider } from '../embedding/deterministic'
import { EmbeddingIdentityError } from '../embedding/provider'
import { hybridSearch, insertDocument, openScopeStore } from './store'

const dirs: string[] = []
const tmpPath = () => {
  const d = mkdtempSync(join(tmpdir(), 'scope-store-'))
  dirs.push(d)
  return join(d, 'memory.sqlite')
}
const cleanup = () => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
}

const provider = createDeterministicProvider(128)

async function seed(path: string, docs: Array<{ title: string; text: string }>) {
  const store = openScopeStore(path, { provider, create: true })
  for (const d of docs) {
    const [embedding] = await provider.embed([d.text], 'document')
    insertDocument(store, {
      title: d.title,
      text: d.text,
      sourceType: 'note',
      createdBy: 'u1',
      chunks: [{ text: d.text, embedding: embedding! }],
    })
  }
  return store
}

describe('scope store', () => {
  test('inserts a document and finds it by exact keyword', async () => {
    const store = await seed(tmpPath(), [
      { title: 'cat', text: 'the domestic cat is a small carnivorous mammal' },
      { title: 'finance', text: 'quarterly revenue forecast and invoice reconciliation' },
    ])
    const [qv] = await provider.embed(['carnivorous mammal'], 'query')
    const hits = hybridSearch(store, 'carnivorous mammal', qv!, 5)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.title).toBe('cat')
    store.close()
    cleanup()
  })

  test('populates all three tables in one transaction', async () => {
    const store = await seed(tmpPath(), [{ title: 'a', text: 'alpha beta gamma' }])
    expect(store.db.prepare('select count(*) as n from documents').get()).toEqual({ n: 1 })
    expect(store.db.prepare('select count(*) as n from chunks').get()).toEqual({ n: 1 })
    expect(store.db.prepare('select count(*) as n from chunks_vec').get()).toEqual({ n: 1 })
    expect(store.db.prepare('select count(*) as n from chunks_fts').get()).toEqual({ n: 1 })
    store.close()
    cleanup()
  })

  test('does not index an image chunk with no text, but still stores its vector', async () => {
    const store = openScopeStore(tmpPath(), { provider, create: true })
    const [imageVec] = await provider.embed(['image'], 'document')
    const [textVec] = await provider.embed(['alpha beta'], 'document')

    insertDocument(store, {
      title: 'screenshot',
      text: '',
      sourceType: 'document',
      createdBy: 'u1',
      chunks: [
        { text: '', embedding: imageVec!, modality: 'image', assetSha256: 'abc', assetMime: 'image/png' },
      ],
    })
    insertDocument(store, {
      title: 'note',
      text: 'alpha beta',
      sourceType: 'note',
      createdBy: 'u1',
      chunks: [{ text: 'alpha beta', embedding: textVec!, modality: 'text' }],
    })

    // chunks_fts is an external-content table, so count(*) scans `chunks` and
    // can never tell us what is indexed. Assert on retrieval instead.
    const matched = store.db
      .prepare('select rowid as id from chunks_fts where chunks_fts match ?')
      .all('"alpha"') as Array<{ id: number }>
    const imageChunkId = (
      store.db.prepare("select id from chunks where modality = 'image'").get() as { id: number }
    ).id
    expect(matched.map((r) => r.id)).not.toContain(imageChunkId)
    expect(matched.length).toBe(1)

    // Both chunks carry a vector, so the image is retrievable semantically.
    expect(store.db.prepare('select count(*) as n from chunks_vec').get()).toEqual({ n: 2 })
    store.close()
    cleanup()
  })

  test('a query with FTS metacharacters does not throw', async () => {
    const store = await seed(tmpPath(), [{ title: 'a', text: 'alpha beta' }])
    const [qv] = await provider.embed(['alpha'], 'query')
    for (const q of ['alpha OR', '"unclosed', 'a AND (b', 'NEAR/', '*', '']) {
      expect(() => hybridSearch(store, q, qv!, 5)).not.toThrow()
    }
    store.close()
    cleanup()
  })

  test('returns vector hits even when no keyword matches', async () => {
    const store = await seed(tmpPath(), [{ title: 'a', text: 'alpha beta gamma delta' }])
    const [qv] = await provider.embed(['alpha beta gamma delta'], 'query')
    const hits = hybridSearch(store, 'zzzznomatchzzzz', qv!, 5)
    expect(hits.length).toBe(1)
    expect(hits[0]!.title).toBe('a')
    store.close()
    cleanup()
  })

  test('respects the limit', async () => {
    const store = await seed(
      tmpPath(),
      Array.from({ length: 10 }, (_, i) => ({ title: `d${i}`, text: `alpha document number ${i}` })),
    )
    const [qv] = await provider.embed(['alpha document'], 'query')
    expect(hybridSearch(store, 'alpha document', qv!, 3).length).toBe(3)
    store.close()
    cleanup()
  })

  test('reopening an existing file preserves its contents', async () => {
    const path = tmpPath()
    const first = await seed(path, [{ title: 'persisted', text: 'alpha beta gamma' }])
    first.close()
    const second = openScopeStore(path, { provider, create: false })
    expect(second.db.prepare('select count(*) as n from documents').get()).toEqual({ n: 1 })
    second.close()
    cleanup()
  })

  test('reopening writable with a different provider throws instead of silently rewriting identity', async () => {
    const path = tmpPath()
    const first = await seed(path, [{ title: 'a', text: 'alpha' }])
    first.close()
    const other = createDeterministicProvider(64) // different dimension
    expect(() => openScopeStore(path, { provider: other, create: false })).toThrow(EmbeddingIdentityError)
    cleanup()
  })

  test('leaves no -wal or -shm sidecar behind', async () => {
    const path = tmpPath()
    const store = await seed(path, [{ title: 'a', text: 'alpha' }])
    store.close()
    expect(existsSync(`${path}-wal`)).toBe(false)
    expect(existsSync(`${path}-shm`)).toBe(false)
    cleanup()
  })
})

describe('FTS query sanitisation', () => {
  test('a stopword-only query does not drag in unrelated documents', async () => {
    const store = await seed(tmpPath(), [
      { title: 'target', text: 'zebra quokka narwhal' },
      { title: 'decoy', text: 'the quick brown fox jumps over for the lazy dog' },
    ])
    // "for"/"the" appear only in the decoy. Before stopword filtering these
    // handed the decoy a BM25 rank-1 that outranked a correct vector hit.
    const [qv] = await provider.embed(['zebra quokka narwhal'], 'query')
    const hits = hybridSearch(store, 'what is the thing for', qv!, 2)
    expect(hits[0]!.title).toBe('target')
    store.close()
    cleanup()
  })

  test('keeps distinctive short-ish terms and still matches lexically', async () => {
    const store = await seed(tmpPath(), [
      { title: 'ticket', text: 'incident GRP-4821 traced to the hydration path' },
      { title: 'other', text: 'unrelated content entirely' },
    ])
    const [qv] = await provider.embed(['unrelated content entirely'], 'query')
    // Vector points at 'other', but the exact ticket id should pull 'ticket' up.
    const hits = hybridSearch(store, 'grp', qv!, 2)
    expect(hits.map((h) => h.title)).toContain('ticket')
    store.close()
    cleanup()
  })
})

describe('ACL enforcement', () => {
  const seedAcl = async (path: string) => {
    const store = openScopeStore(path, { provider, create: true })
    const add = async (title: string, text: string, acl?: Parameters<typeof insertDocument>[1]['acl']) => {
      const [embedding] = await provider.embed([text], 'document')
      insertDocument(store, {
        title, text, sourceType: 'note', createdBy: 'author', acl,
        chunks: [{ text, embedding: embedding! }],
      })
    }
    await add('open', 'shared briefing about quarterly planning')
    await add('alice-only', 'private briefing about quarterly planning', {
      tenantId: 'org1', visibility: 'restricted', readPrincipals: ['alice'],
    })
    await add('eng-only', 'engineering briefing about quarterly planning', {
      tenantId: 'org1', visibility: 'restricted', readRoles: ['Engineer'],
    })
    await add('group-only', 'group briefing about quarterly planning', {
      tenantId: 'org1', visibility: 'restricted', readGroups: ['g-42'],
    })
    return store
  }
  const query = 'briefing quarterly planning'

  test('an unprivileged reader sees only public documents', async () => {
    const store = await seedAcl(tmpPath())
    const [qv] = await provider.embed([query], 'query')
    const titles = hybridSearch(store, query, qv!, 10, { subjectId: 'mallory', tenantId: 'org1' }).map((h) => h.title)
    expect(titles).toEqual(['open'])
    store.close()
    cleanup()
  })

  test('a named principal sees their own restricted document', async () => {
    const store = await seedAcl(tmpPath())
    const [qv] = await provider.embed([query], 'query')
    const titles = hybridSearch(store, query, qv!, 10, { subjectId: 'alice', tenantId: 'org1' }).map((h) => h.title)
    expect(titles).toContain('alice-only')
    expect(titles).not.toContain('eng-only')
    store.close()
    cleanup()
  })

  test('role and group membership grant access, case-insensitively', async () => {
    const store = await seedAcl(tmpPath())
    const [qv] = await provider.embed([query], 'query')
    const titles = hybridSearch(store, query, qv!, 10, {
      subjectId: 'bob', tenantId: 'org1', roles: ['ENGINEER'], groupIds: ['G-42'],
    }).map((h) => h.title)
    expect(titles).toContain('eng-only')
    expect(titles).toContain('group-only')
    expect(titles).not.toContain('alice-only')
    store.close()
    cleanup()
  })

  test('a mismatched tenant sees nothing restricted', async () => {
    const store = await seedAcl(tmpPath())
    const [qv] = await provider.embed([query], 'query')
    const titles = hybridSearch(store, query, qv!, 10, {
      subjectId: 'alice', tenantId: 'other-org', roles: ['engineer'],
    }).map((h) => h.title)
    expect(titles).toEqual(['open'])
    store.close()
    cleanup()
  })

  test('omitting the ACL context returns everything (unenforced internal use)', async () => {
    const store = await seedAcl(tmpPath())
    const [qv] = await provider.embed([query], 'query')
    expect(hybridSearch(store, query, qv!, 10).length).toBe(4)
    store.close()
    cleanup()
  })
})
