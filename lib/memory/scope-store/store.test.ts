import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDeterministicProvider } from '../embedding/deterministic'
import { EmbeddingIdentityError } from '../embedding/provider'
import {
  hybridSearch,
  deleteDocuments,
  distinctEdgeNodes,
  updateDocumentFields,
  listFacts,
  listMemoryEdges,
  insertDocument,
  moveToPlacement,
  openScopeStore,
  resolveEntities,
  type MemoryEdgeInput,
  type NodeVectors,
  type ScopeStore,
} from './store'

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

    const matched = store.db
      .prepare('select rowid as id from chunks_fts where chunks_fts match ?')
      .all('"alpha"') as Array<{ id: number }>
    const imageChunkId = (
      store.db.prepare("select id from chunks where modality = 'image'").get() as { id: number }
    ).id
    expect(matched.map((r) => r.id)).not.toContain(imageChunkId)
    expect(matched.length).toBe(1)

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
    const other = createDeterministicProvider(64) 
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

describe('folder scoping', () => {
  const FOLDER = 'folder-onboarding'
  const OTHER = 'folder-billing'
  const query = 'briefing quarterly planning'

  const seedFolders = async (path: string) => {
    const store = openScopeStore(path, { provider, create: true })
    const add = async (
      title: string,
      text: string,
      folderId: string | null,
      acl?: Parameters<typeof insertDocument>[1]['acl'],
    ) => {
      const [embedding] = await provider.embed([text], 'document')
      return insertDocument(store, {
        title, text, sourceType: 'chat', createdBy: 'alice', folderId, acl,
        chunks: [{ text, embedding: embedding! }],
      })
    }
    await add('in-folder', 'briefing about quarterly planning one', FOLDER, {
      tenantId: 'org1', visibility: 'restricted', readGroups: [FOLDER],
    })
    await add('other-folder', 'briefing about quarterly planning two', OTHER, {
      tenantId: 'org1', visibility: 'restricted', readGroups: [OTHER],
    })
    const loose = await add('public-unfiled', 'briefing about quarterly planning three', null)
    return { store, loose }
  }

  test('a folder query returns only that folder, not public documents outside it', async () => {
    const { store } = await seedFolders(tmpPath())
    const [qv] = await provider.embed([query], 'query')
    const titles = hybridSearch(store, query, qv!, 10, { subjectId: 'alice', tenantId: 'org1', groupIds: [FOLDER] }, undefined, { folderId: FOLDER })
      .map((h) => h.title)
    expect(titles).toEqual(['in-folder'])
    store.close()
    cleanup()
  })

  test('ACL alone would have leaked the public document — folder filter is what stops it', async () => {
    const { store } = await seedFolders(tmpPath())
    const [qv] = await provider.embed([query], 'query')
    const withoutFolder = hybridSearch(store, query, qv!, 10, {
      subjectId: 'alice', tenantId: 'org1', groupIds: [FOLDER],
    }).map((h) => h.title)
    expect(withoutFolder).toContain('public-unfiled')
    expect(withoutFolder).toContain('in-folder')
    store.close()
    cleanup()
  })

  test('folderId null scopes to unfiled documents only', async () => {
    const { store } = await seedFolders(tmpPath())
    const [qv] = await provider.embed([query], 'query')
    const titles = hybridSearch(store, query, qv!, 10, { subjectId: 'alice', tenantId: 'org1' }, undefined, { folderId: null })
      .map((h) => h.title)
    expect(titles).toEqual(['public-unfiled'])
    store.close()
    cleanup()
  })

  test('a member of one folder cannot read another folder even by naming it', async () => {
    const { store } = await seedFolders(tmpPath())
    const [qv] = await provider.embed([query], 'query')
    const titles = hybridSearch(store, query, qv!, 10, { subjectId: 'bob', tenantId: 'org1', groupIds: [FOLDER] }, undefined, { folderId: OTHER })
      .map((h) => h.title)
    expect(titles).toEqual([])
    store.close()
    cleanup()
  })

  test('moveToPlacement relabels a chat and adopts the folder ACL, copying nothing', async () => {
    const path = tmpPath()
    const { store, loose } = await seedFolders(path)
    const before = store.db.prepare('select count(*) as n from chunks').get() as { n: number }

    expect(moveToPlacement(store, [loose], { folderId: FOLDER }, {
      tenantId: 'org1', visibility: 'restricted', readGroups: [FOLDER],
    })).toBe(1)

    expect(store.db.prepare('select count(*) as n from chunks').get()).toEqual(before)

    const [qv] = await provider.embed([query], 'query')
    const titles = hybridSearch(store, query, qv!, 10, { subjectId: 'alice', tenantId: 'org1', groupIds: [FOLDER] }, undefined, { folderId: FOLDER })
      .map((h) => h.title)
    expect(titles.sort()).toEqual(['in-folder', 'public-unfiled'])

    expect(
      hybridSearch(store, query, qv!, 10, { subjectId: 'alice', tenantId: 'org1' }, undefined, { folderId: null }),
    ).toEqual([])
    store.close()
    cleanup()
  })

  test('moving out of a folder keeps the ACL restrictive', async () => {
    const path = tmpPath()
    const { store, loose } = await seedFolders(path)
    moveToPlacement(store, [loose], { folderId: FOLDER }, { tenantId: 'org1', visibility: 'restricted', readGroups: [FOLDER] })
    moveToPlacement(store, [loose], { folderId: null })

    const [qv] = await provider.embed([query], 'query')
    const outsider = hybridSearch(store, query, qv!, 10, { subjectId: 'mallory', tenantId: 'org1' }, undefined, { folderId: null })
    expect(outsider).toEqual([])
    store.close()
    cleanup()
  })
})

describe('workspace and folder are separate hierarchies', () => {
  const WS = 'ws-acme'
  const OTHER_WS = 'ws-globex'
  const FOLDER = 'folder-onboarding'
  const query = 'briefing quarterly planning'

  const seedPlacements = async (path: string) => {
    const store = openScopeStore(path, { provider, create: true })
    const add = async (
      title: string,
      text: string,
      placement: { workspaceId?: string | null; folderId?: string | null },
    ) => {
      const [embedding] = await provider.embed([text], 'document')
      return insertDocument(store, {
        title, text, sourceType: 'chat', createdBy: 'alice',
        ...placement,
        chunks: [{ text, embedding: embedding! }],
      })
    }
    await add('ws-filed', 'briefing about quarterly planning one', { workspaceId: WS, folderId: FOLDER })
    await add('ws-loose', 'briefing about quarterly planning two', { workspaceId: WS })
    await add('other-ws', 'briefing about quarterly planning three', { workspaceId: OTHER_WS, folderId: FOLDER })
    await add('personal', 'briefing about quarterly planning four', {})
    return store
  }

  const titlesFor = async (
    store: ReturnType<typeof openScopeStore>,
    scope: Parameters<typeof hybridSearch>[6],
  ) => {
    const [qv] = await provider.embed([query], 'query')
    return hybridSearch(store, query, qv!, 10, undefined, undefined, scope).map((h) => h.title).sort()
  }

  test('a workspace owns its folders: querying the workspace returns filed and unfiled alike', async () => {
    const store = await seedPlacements(tmpPath())
    expect(await titlesFor(store, { workspaceId: WS })).toEqual(['ws-filed', 'ws-loose'])
    store.close()
    cleanup()
  })

  test('a folder narrows within its workspace without reaching the same folder name elsewhere', async () => {
    const store = await seedPlacements(tmpPath())
    expect(await titlesFor(store, { workspaceId: WS, folderId: FOLDER })).toEqual(['ws-filed'])
    store.close()
    cleanup()
  })

  test('a folder name alone is not a hierarchy: it spans workspaces unless one is named', async () => {
    const store = await seedPlacements(tmpPath())
    expect(await titlesFor(store, { folderId: FOLDER })).toEqual(['other-ws', 'ws-filed'])
    store.close()
    cleanup()
  })

  test('personal memory is the null workspace, not a workspace with no folder', async () => {
    const store = await seedPlacements(tmpPath())
    expect(await titlesFor(store, { workspaceId: null })).toEqual(['personal'])
    expect(await titlesFor(store, { workspaceId: WS, folderId: null })).toEqual(['ws-loose'])
    store.close()
    cleanup()
  })

  test('an unscoped query still sees every hierarchy', async () => {
    const store = await seedPlacements(tmpPath())
    expect(await titlesFor(store, undefined)).toEqual(['other-ws', 'personal', 'ws-filed', 'ws-loose'])
    store.close()
    cleanup()
  })

  test('moving into a folder keeps the document in its workspace', async () => {
    const path = tmpPath()
    const store = await seedPlacements(path)
    const loose = store.db.prepare("select id from documents where title = 'ws-loose'").get() as { id: string }

    expect(moveToPlacement(store, [loose.id], { folderId: FOLDER })).toBe(1)

    expect(await titlesFor(store, { workspaceId: WS, folderId: FOLDER })).toEqual(['ws-filed', 'ws-loose'])
    expect(await titlesFor(store, { workspaceId: WS })).toEqual(['ws-filed', 'ws-loose'])
    store.close()
    cleanup()
  })

  test('promoting a personal document sets both placements in one move', async () => {
    const path = tmpPath()
    const store = await seedPlacements(path)
    const personal = store.db.prepare("select id from documents where title = 'personal'").get() as { id: string }

    expect(moveToPlacement(store, [personal.id], { workspaceId: WS, folderId: FOLDER })).toBe(1)

    expect(await titlesFor(store, { workspaceId: null })).toEqual([])
    expect(await titlesFor(store, { workspaceId: WS, folderId: FOLDER })).toEqual(['personal', 'ws-filed'])
    store.close()
    cleanup()
  })

  test('an omitted placement is left alone, an explicit null clears it', async () => {
    const path = tmpPath()
    const store = await seedPlacements(path)
    const filed = store.db.prepare("select id from documents where title = 'ws-filed'").get() as { id: string }

    moveToPlacement(store, [filed.id], { folderId: null })
    expect(await titlesFor(store, { workspaceId: WS, folderId: null })).toEqual(['ws-filed', 'ws-loose'])

    moveToPlacement(store, [filed.id], { workspaceId: null })
    expect(await titlesFor(store, { workspaceId: null })).toEqual(['personal', 'ws-filed'])
    store.close()
    cleanup()
  })

  test('a move that names no placement and no ACL touches nothing', async () => {
    const path = tmpPath()
    const store = await seedPlacements(path)
    const filed = store.db.prepare("select id from documents where title = 'ws-filed'").get() as { id: string }

    expect(moveToPlacement(store, [filed.id], {})).toBe(0)
    expect(await titlesFor(store, { workspaceId: WS, folderId: FOLDER })).toEqual(['ws-filed'])
    store.close()
    cleanup()
  })

  test('moving a document id that is not in the store reports nothing moved', async () => {
    const path = tmpPath()
    const store = await seedPlacements(path)

    expect(moveToPlacement(store, ['does-not-exist'], { folderId: FOLDER })).toBe(0)
    store.close()
    cleanup()
  })
})

describe('placement migration', () => {
  test('a pre-split store holding workspace ids in folder_id is rewritten on open', async () => {
    const path = tmpPath()
    const store = openScopeStore(path, { provider, create: true })
    const [embedding] = await provider.embed(['legacy placement text'], 'document')
    insertDocument(store, {
      title: 'legacy', text: 'legacy placement text', sourceType: 'chat', createdBy: 'alice',
      chunks: [{ text: 'legacy placement text', embedding: embedding! }],
    })
    store.db.run("update documents set folder_id = 'ws-legacy', workspace_id = null")
    store.db.run("update meta set value = '5' where key = 'schema_version'")
    store.close()

    const reopened = openScopeStore(path, { provider, create: false })
    const row = reopened.db
      .prepare('select workspace_id as workspaceId, folder_id as folderId from documents')
      .get() as { workspaceId: string | null; folderId: string | null }

    expect(row).toEqual({ workspaceId: 'ws-legacy', folderId: null })
    reopened.close()
    cleanup()
  })
})

describe('graph-driven retrieval', () => {
  const FILLER = 20

  async function seedGraph(path: string, linked: boolean) {
    const store = openScopeStore(path, { provider, create: true })
    const add = async (title: string, text: string, edges?: MemoryEdgeInput[]) => {
      const [embedding] = await provider.embed([text], 'document')
      insertDocument(store, {
        title, text, sourceType: 'note', createdBy: 'u1', edges,
        chunks: [{ text, embedding: embedding! }],
      })
    }
    for (let i = 0; i < FILLER; i++) {
      await add(`filler-${i}`, `helios cutover status note ${i} covering rollout readiness and sign off`)
    }
    await add(
      'lamination',
      'butter is folded into dough across several chilled resting cycles',
      linked ? [{ source: 'Helios', target: 'lamination runbook', relation: 'documented in' }] : undefined,
    )
    await add(
      'bakery staffing',
      'the weekend roster rotates between two shifts with one floater on call',
      linked ? [{ source: 'lamination runbook', target: 'weekend roster', relation: 'staffed by' }] : undefined,
    )
    return store
  }

  test('an edge from an entity named in the question pulls in a document search would miss', async () => {
    const store = await seedGraph(tmpPath(), true)
    const [qv] = await provider.embed(['who owns helios'], 'query')
    const titles = hybridSearch(store, 'who owns helios', qv!, 5).map((h) => h.title)

    expect(titles).toContain('lamination')
    store.close()
    cleanup()
  })

  test('the same corpus without edges leaves that document unreachable', async () => {
    const store = await seedGraph(tmpPath(), false)
    const [qv] = await provider.embed(['who owns helios'], 'query')
    const titles = hybridSearch(store, 'who owns helios', qv!, 5).map((h) => h.title)

    expect(titles).not.toContain('lamination')
    store.close()
    cleanup()
  })

  test('the walk follows a second hop away from the seed entity', async () => {
    const store = await seedGraph(tmpPath(), true)
    const [qv] = await provider.embed(['who owns helios'], 'query')
    const titles = hybridSearch(store, 'who owns helios', qv!, 8).map((h) => h.title)

    expect(titles).toContain('bakery staffing')
    store.close()
    cleanup()
  })

  test('a question naming no known entity retrieves exactly what it did before', async () => {
    const withGraph = await seedGraph(tmpPath(), true)
    const withoutGraph = await seedGraph(tmpPath(), false)
    const [qv] = await provider.embed(['rollout readiness sign off'], 'query')

    expect(hybridSearch(withGraph, 'rollout readiness sign off', qv!, 5).map((h) => h.title)).toEqual(
      hybridSearch(withoutGraph, 'rollout readiness sign off', qv!, 5).map((h) => h.title),
    )
    withGraph.close()
    withoutGraph.close()
    cleanup()
  })

  test('graph candidates are still filtered by placement', async () => {
    const store = await seedGraph(tmpPath(), true)
    const [qv] = await provider.embed(['who owns helios'], 'query')
    const titles = hybridSearch(store, 'who owns helios', qv!, 5, undefined, undefined, {
      workspaceId: 'ws-other',
    }).map((h) => h.title)

    expect(titles).toEqual([])
    store.close()
    cleanup()
  })
})

describe('entity resolution', () => {
  async function seedEntities(path: string) {
    const store = openScopeStore(path, { provider, create: true })
    const text = 'the helios cutover ships once staffing is confirmed'
    const [embedding] = await provider.embed([text], 'document')
    insertDocument(store, {
      title: 'helios', text, sourceType: 'note', createdBy: 'u1',
      edges: [{ source: 'Helios cutover', target: 'Marcy Wu', relation: 'owned by' }],
      chunks: [{ text, embedding: embedding! }],
    })
    return store
  }

  test('reports the entity a query actually resolved to', async () => {
    const store = await seedEntities(tmpPath())

    expect(resolveEntities(store, 'who owns the helios cutover').matched).toEqual(['Helios cutover'])
    store.close()
    cleanup()
  })

  test('offers the stored spelling when a query names an entity it cannot resolve', async () => {
    const store = await seedEntities(tmpPath())
    const { matched, suggested } = resolveEntities(store, 'what did marcy decide')

    expect(matched).toEqual([])
    expect(suggested).toEqual(['Marcy Wu'])
    store.close()
    cleanup()
  })

  test('offers nothing when no stored entity resembles the query', async () => {
    const store = await seedEntities(tmpPath())

    expect(resolveEntities(store, 'lamination resting cycles')).toEqual({ matched: [], suggested: [] })
    store.close()
    cleanup()
  })

  test('never suggests a name it already reported as matched', async () => {
    const store = await seedEntities(tmpPath())
    const { matched, suggested } = resolveEntities(store, 'helios cutover and marcy')

    expect(matched).toEqual(['Helios cutover'])
    expect(suggested).toEqual(['Marcy Wu'])
    store.close()
    cleanup()
  })

  test('resolves nothing against a store that has no graph', async () => {
    const store = await seed(tmpPath(), [{ title: 'a', text: 'alpha beta gamma' }])
    store.db.run('drop table memory_edges')

    expect(resolveEntities(store, 'alpha')).toEqual({ matched: [], suggested: [] })
    store.close()
    cleanup()
  })
})

describe('entity aliasing', () => {
  const seedAliases = async (path: string) => {
    const store = openScopeStore(path, { provider, create: true })
    const text = 'the migration ships once staffing is confirmed'
    const [embedding] = await provider.embed([text], 'document')
    insertDocument(store, {
      title: 'migration', text, sourceType: 'note', createdBy: 'u1',
      edges: [{ source: 'Acme Corp.', target: 'Marcy Wu', relation: 'owned by' }],
      chunks: [{ text, embedding: embedding! }],
    })
    return store
  }

  test('resolves an entity written without its legal suffix', async () => {
    const store = await seedAliases(tmpPath())
    expect(resolveEntities(store, 'what is acme doing').matched).toEqual(['Acme Corp.'])
    store.close()
    cleanup()
  })

  test('resolves the exact stored spelling too', async () => {
    const store = await seedAliases(tmpPath())
    expect(resolveEntities(store, 'what is acme corp doing').matched).toEqual(['Acme Corp.'])
    store.close()
    cleanup()
  })

  test('lists edges for a spelling that is not the stored one', async () => {
    const store = await seedAliases(tmpPath())
    const edges = listMemoryEdges(store, { entity: 'acme' })
    expect(edges.map((e) => e.source)).toEqual(['Acme Corp.'])
    store.close()
    cleanup()
  })

  test('an unknown entity still lists nothing', async () => {
    const store = await seedAliases(tmpPath())
    expect(listMemoryEdges(store, { entity: 'globex' })).toEqual([])
    store.close()
    cleanup()
  })

  test('suggests a near name without a full-table scan', async () => {
    const store = await seedAliases(tmpPath())
    const { matched, suggested } = resolveEntities(store, 'what did marcy decide')
    expect(matched).toEqual([])
    expect(suggested).toEqual(['Marcy Wu'])
    store.close()
    cleanup()
  })

  test('a scope file predating the alias index keeps its old behaviour', async () => {
    const store = await seedAliases(tmpPath())
    store.db.run('drop table memory_node_aliases')
    store.db.run('drop table memory_nodes_fts')

    // Exact-key matching, as before: 'Marcy Wu' resolves, and the LIKE-scan
    // fallback still offers near names.
    expect(resolveEntities(store, 'what did marcy wu decide').matched).toEqual(['Marcy Wu'])
    expect(resolveEntities(store, 'what did marcy decide').suggested).toEqual(['Marcy Wu'])
    store.close()
    cleanup()
  })

  test('an entity whose stored name carries punctuation is now reachable from a query', async () => {
    const store = await seedAliases(tmpPath())
    // The legacy key keeps the trailing period while query text is tokenized
    // without it, so 'Acme Corp.' was unreachable before the canonical key.
    store.db.run('drop table memory_node_aliases')
    expect(resolveEntities(store, 'what is acme corp doing').matched).toEqual([])

    const fresh = await seedAliases(tmpPath())
    expect(resolveEntities(fresh, 'what is acme corp doing').matched).toEqual(['Acme Corp.'])
    store.close()
    fresh.close()
    cleanup()
  })
})

describe('deleted documents', () => {
  const seedDeletable = async (path: string) => {
    const store = openScopeStore(path, { provider, create: true })
    const add = async (id: string, title: string, text: string, edges?: MemoryEdgeInput[]) => {
      const [embedding] = await provider.embed([text], 'document')
      insertDocument(store, {
        id, title, text, sourceType: 'fact', createdBy: 'u1', edges,
        chunks: [{ text, embedding: embedding! }],
      })
    }
    await add('keep', 'keeper', 'quarterly planning briefing that survives')
    await add('drop', 'doomed', 'quarterly planning briefing that is removed', [
      { source: 'Helios', target: 'doomed runbook', relation: 'documented in' },
    ])
    return store
  }

  test('a tombstoned document disappears from search', async () => {
    const store = await seedDeletable(tmpPath())
    const [qv] = await provider.embed(['quarterly planning briefing'], 'query')

    expect(hybridSearch(store, 'quarterly planning briefing', qv!, 10).map((h) => h.title)).toContain('doomed')
    expect(deleteDocuments(store, ['drop'])).toBe(1)

    const titles = hybridSearch(store, 'quarterly planning briefing', qv!, 10).map((h) => h.title)
    expect(titles).toContain('keeper')
    expect(titles).not.toContain('doomed')
    store.close()
    cleanup()
  })

  test('it disappears from stored facts', async () => {
    const store = await seedDeletable(tmpPath())
    deleteDocuments(store, ['drop'])
    expect(listFacts(store).map((f) => f.title)).toEqual(['keeper'])
    store.close()
    cleanup()
  })

  test('its relationships stop being listed', async () => {
    const store = await seedDeletable(tmpPath())
    expect(listMemoryEdges(store, { entity: 'Helios' })).not.toEqual([])
    deleteDocuments(store, ['drop'])
    expect(listMemoryEdges(store, { entity: 'Helios' })).toEqual([])
    store.close()
    cleanup()
  })

  test('deleting is idempotent and reports what it actually changed', async () => {
    const store = await seedDeletable(tmpPath())
    expect(deleteDocuments(store, ['drop'])).toBe(1)
    expect(deleteDocuments(store, ['drop'])).toBe(0)
    expect(deleteDocuments(store, ['never-existed'])).toBe(0)
    expect(deleteDocuments(store, [])).toBe(0)
    store.close()
    cleanup()
  })

  test('the surviving document is untouched', async () => {
    const store = await seedDeletable(tmpPath())
    deleteDocuments(store, ['drop'])
    expect(store.db.prepare('select count(*) as n from chunks').get()).toEqual({ n: 2 })
    expect(listFacts(store).map((f) => f.documentId)).toEqual(['keep'])
    store.close()
    cleanup()
  })
})

describe('recall under a filter', () => {
  const VISIBLE = 5
  const HIDDEN = 195

  const seedCrowded = async (path: string) => {
    const store = openScopeStore(path, { provider, create: true })
    const add = async (title: string, text: string, acl?: Parameters<typeof insertDocument>[1]['acl']) => {
      const [embedding] = await provider.embed([text], 'document')
      insertDocument(store, {
        title, text, sourceType: 'note', createdBy: 'author', acl,
        chunks: [{ text, embedding: embedding! }],
      })
    }
    for (let i = 0; i < HIDDEN; i++) {
      await add(`hidden-${i}`, `quarterly planning briefing number ${i}`, {
        tenantId: 'org1', visibility: 'restricted', readPrincipals: ['someone-else'],
      })
    }
    for (let i = 0; i < VISIBLE; i++) {
      await add(`visible-${i}`, `quarterly planning briefing number ${HIDDEN + i}`)
    }
    return store
  }

  /**
   * The candidate pool is chosen before placement and ACL are applied, so a
   * reader who can see 5 documents out of 200 needs the pool widened past the
   * first CANDIDATE_DEPTH rows before any of theirs appear.
   */
  test('a reader still receives every document they are allowed to see', async () => {
    const store = await seedCrowded(tmpPath())
    const [qv] = await provider.embed(['quarterly planning briefing'], 'query')
    const titles = hybridSearch(store, 'quarterly planning briefing', qv!, VISIBLE, {
      subjectId: 'mallory',
      tenantId: 'org1',
    }).map((h) => h.title)

    expect(titles.length).toBe(VISIBLE)
    expect(new Set(titles).size).toBe(VISIBLE)
    expect(titles.every((t) => t.startsWith('visible-'))).toBe(true)
    store.close()
    cleanup()
  })

  test('an unfiltered search is still answered from the first pass', async () => {
    const store = await seedCrowded(tmpPath())
    const [qv] = await provider.embed(['quarterly planning briefing'], 'query')
    expect(hybridSearch(store, 'quarterly planning briefing', qv!, 5).length).toBe(5)
    store.close()
    cleanup()
  })
})

describe('document field updates', () => {
  const seedRenamable = async (path: string) => {
    const store = openScopeStore(path, { provider, create: true })
    const text = 'quarterly planning briefing for the rollout'
    const [embedding] = await provider.embed([text], 'document')
    insertDocument(store, {
      id: 'doc1', title: 'old name', text, sourceType: 'note', createdBy: 'u1',
      sourceUrl: 'r2://old-key',
      chunks: [{ text, embedding: embedding! }],
    })
    return store
  }

  const search = async (store: Awaited<ReturnType<typeof seedRenamable>>) => {
    const [qv] = await provider.embed(['quarterly planning briefing'], 'query')
    return hybridSearch(store, 'quarterly planning briefing', qv!, 5)
  }

  test('a renamed document is cited under its new title', async () => {
    const store = await seedRenamable(tmpPath())
    expect(updateDocumentFields(store, 'doc1', { title: 'new name' })).toBe(1)
    expect((await search(store)).map((h) => h.title)).toEqual(['new name'])
    store.close()
    cleanup()
  })

  test('sourceUrl can be rewritten, and cleared', async () => {
    const store = await seedRenamable(tmpPath())
    updateDocumentFields(store, 'doc1', { sourceUrl: 'r2://new-key' })
    expect((await search(store))[0]!.sourceUrl).toBe('r2://new-key')

    updateDocumentFields(store, 'doc1', { sourceUrl: null })
    expect((await search(store))[0]!.sourceUrl).toBeNull()
    store.close()
    cleanup()
  })

  test('an omitted field is left alone', async () => {
    const store = await seedRenamable(tmpPath())
    updateDocumentFields(store, 'doc1', { title: 'new name' })
    expect((await search(store))[0]!.sourceUrl).toBe('r2://old-key')
    store.close()
    cleanup()
  })

  test('chunk text is untouched, so the embeddings still describe it', async () => {
    const store = await seedRenamable(tmpPath())
    updateDocumentFields(store, 'doc1', { title: 'new name' })
    expect((await search(store))[0]!.text).toBe('quarterly planning briefing for the rollout')
    store.close()
    cleanup()
  })

  test('nothing to change reports zero without touching the row', async () => {
    const store = await seedRenamable(tmpPath())
    expect(updateDocumentFields(store, 'doc1', {})).toBe(0)
    expect(updateDocumentFields(store, 'missing', { title: 'x' })).toBe(0)
    store.close()
    cleanup()
  })

  test('a forgotten document cannot be renamed back into view', async () => {
    const store = await seedRenamable(tmpPath())
    deleteDocuments(store, ['doc1'])
    expect(updateDocumentFields(store, 'doc1', { title: 'new name' })).toBe(0)
    expect(await search(store)).toEqual([])
    store.close()
    cleanup()
  })

  describe('image chunks, which carry the title as their text', () => {
    const seedWithImage = async (path: string) => {
      const store = openScopeStore(path, { provider, create: true })
      const [vector] = await provider.embed(['picture'], 'document')
      insertDocument(store, {
        id: 'doc1', title: 'kingfisher sketch', text: '', sourceType: 'note', createdBy: 'u1',
        chunks: [{
          text: 'kingfisher sketch', embedding: vector!, modality: 'image',
          assetSha256: 'abc', assetMime: 'image/png',
        }],
      })
      return store
    }

    const chunkText = (store: ScopeStore) =>
      (store.db.prepare("select text from chunks where modality = 'image'").get() as { text: string }).text

    const ftsMatches = (store: ScopeStore, term: string) =>
      (store.db
        .prepare('select count(*) as n from chunks_fts where chunks_fts match ?')
        .get(term) as { n: number }).n

    test('a rename moves the image chunk text with it', async () => {
      const store = await seedWithImage(tmpPath())
      updateDocumentFields(store, 'doc1', { title: 'heron sketch' })
      expect(chunkText(store)).toBe('heron sketch')
      store.close()
      cleanup()
    })

    test('the full-text index stops answering to the old title', async () => {
      const store = await seedWithImage(tmpPath())
      expect(ftsMatches(store, 'kingfisher')).toBe(1)

      updateDocumentFields(store, 'doc1', { title: 'heron sketch' })

      expect(ftsMatches(store, 'kingfisher')).toBe(0)
      expect(ftsMatches(store, 'heron')).toBe(1)
      store.close()
      cleanup()
    })

    test('a text chunk that happens to read like the title is left alone', async () => {
      const store = openScopeStore(tmpPath(), { provider, create: true })
      const [vector] = await provider.embed(['kingfisher sketch'], 'document')
      insertDocument(store, {
        id: 'doc1', title: 'kingfisher sketch', text: 'kingfisher sketch',
        sourceType: 'note', createdBy: 'u1',
        chunks: [{ text: 'kingfisher sketch', embedding: vector!, modality: 'text' }],
      })

      updateDocumentFields(store, 'doc1', { title: 'heron sketch' })

      const text = (store.db
        .prepare("select text from chunks where modality = 'text'")
        .get() as { text: string }).text
      expect(text).toBe('kingfisher sketch')
      store.close()
      cleanup()
    })

    test('renaming to the same title changes nothing', async () => {
      const store = await seedWithImage(tmpPath())
      expect(updateDocumentFields(store, 'doc1', { title: 'kingfisher sketch' })).toBe(1)
      expect(chunkText(store)).toBe('kingfisher sketch')
      expect(ftsMatches(store, 'kingfisher')).toBe(1)
      store.close()
      cleanup()
    })
  })
})

describe('semantic entity resolution', () => {
  const edges: MemoryEdgeInput[] = [
    { source: 'Helios cutover', target: 'Marcy Wu', relation: 'owned by' },
  ]

  // Mirrors service.embedEdgeNodes: a label vector per distinct node.
  async function nodeVectorsFor(list: MemoryEdgeInput[]): Promise<NodeVectors> {
    const nodes = distinctEdgeNodes(list)
    const vectors = await provider.embed(
      nodes.map((n) => n.label),
      'document',
    )
    return new Map(nodes.map((n, i) => [n.id, vectors[i]!]))
  }

  async function seed(path: string, withVectors: boolean): Promise<ScopeStore> {
    const store = openScopeStore(path, { provider, create: true })
    const text = 'the helios cutover ships once staffing is confirmed'
    const [embedding] = await provider.embed([text], 'document')
    insertDocument(store, {
      title: 'helios',
      text,
      sourceType: 'note',
      createdBy: 'u1',
      edges,
      nodeVectors: withVectors ? await nodeVectorsFor(edges) : undefined,
      chunks: [{ text, embedding: embedding! }],
    })
    return store
  }

  const vecCount = (store: ScopeStore) =>
    (store.db.prepare('select count(*) as n from memory_nodes_vec').get() as { n: number }).n

  test('writes one label vector per distinct node', async () => {
    const store = await seed(tmpPath(), true)
    expect(vecCount(store)).toBe(2)
    store.close()
    cleanup()
  })

  test('matches an entity by meaning when the spelling shares nothing', async () => {
    const store = await seed(tmpPath(), true)
    const [marcy] = await provider.embed(['Marcy Wu'], 'query')

    // "zzzqqq wxyz" shares no alias and no trigram with any label, so only the
    // vector tier can surface Marcy — and it does, because the query vector is
    // her own embedding.
    const blind = resolveEntities(store, 'zzzqqq wxyz')
    expect(blind.suggested).toEqual([])

    const semantic = resolveEntities(store, 'zzzqqq wxyz', 6, marcy)
    expect(semantic.suggested).toContain('Marcy Wu')
    store.close()
    cleanup()
  })

  test('drops candidates past the distance cutoff', async () => {
    const store = await seed(tmpPath(), true)
    // An embedding unrelated to any stored label sits ~sqrt(2) away once
    // normalized — well beyond NODE_SEMANTIC_MAX_DISTANCE.
    const [far] = await provider.embed(['unrelated lamination cycles'], 'query')

    expect(resolveEntities(store, 'zzzqqq wxyz', 6, far).suggested).toEqual([])
    store.close()
    cleanup()
  })

  test('never demotes an exact match to a semantic suggestion', async () => {
    const store = await seed(tmpPath(), true)
    const [helios] = await provider.embed(['Helios cutover'], 'query')
    const { matched, suggested } = resolveEntities(store, 'who owns the helios cutover', 6, helios)

    expect(matched).toEqual(['Helios cutover'])
    expect(suggested).not.toContain('Helios cutover')
    store.close()
    cleanup()
  })

  test('a scope written without vectors still resolves, ignoring the empty tier', async () => {
    const store = await seed(tmpPath(), false)
    expect(vecCount(store)).toBe(0)
    const [marcy] = await provider.embed(['Marcy Wu'], 'query')

    // No vector was stored, so the semantic tier contributes nothing; exact
    // resolution still works.
    expect(resolveEntities(store, 'zzzqqq wxyz', 6, marcy).suggested).toEqual([])
    expect(resolveEntities(store, 'who owns the helios cutover', 6, marcy).matched).toEqual([
      'Helios cutover',
    ])
    store.close()
    cleanup()
  })

  test('keeps a node’s first vector when the entity is mentioned again', async () => {
    const path = tmpPath()
    const store = await seed(path, true)
    expect(vecCount(store)).toBe(2)

    // A second document naming Marcy again must not add or move her vector row.
    const text = 'marcy wu approved the staffing plan'
    const [embedding] = await provider.embed([text], 'document')
    insertDocument(store, {
      title: 'staffing',
      text,
      sourceType: 'note',
      createdBy: 'u1',
      edges: [{ source: 'Marcy Wu', target: 'Staffing plan', relation: 'approved' }],
      nodeVectors: await nodeVectorsFor([
        { source: 'Marcy Wu', target: 'Staffing plan', relation: 'approved' },
      ]),
      chunks: [{ text, embedding: embedding! }],
    })

    // Marcy (existing) reused, Staffing plan (new) added: 3, not 4.
    expect(vecCount(store)).toBe(3)
    store.close()
    cleanup()
  })
})
