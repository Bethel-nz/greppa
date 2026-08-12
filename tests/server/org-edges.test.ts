import { sharedCp } from './_memory-mocks'
import { describe, expect, test } from 'bun:test'

const { commitMemoryCard } = await import('~/lib/memory/service')
const { openScopeStore, listMemoryEdges } = await import('~/lib/memory/scope-store/store')
const { getEmbeddingProvider } = await import('~/lib/memory/embedding')

let n = 0
const freshOrg = () => `org${Date.now()}-${n++}`

const aclFor = (orgId: string) => ({
  tenantId: orgId,
  subjectId: 'u1',
  roles: ['member'],
  groupIds: [],
})

async function commit(
  orgId: string,
  edges?: Array<{ source: string; target: string; relation: string }>,
) {
  await commitMemoryCard({
    acl: aclFor(orgId),
    userId: 'u1',
    documentId: `doc-${orgId}`,
    title: 'Helios migration plan',
    text: 'The Helios cutover is owned by Marcy Wu. Rollback drains the queue first.',
    sourceType: 'document',
    edges,
  })
}

/** Reads the org scope file back out of storage the way a cold reader would. */
async function edgesOf(orgId: string) {
  return sharedCp.read(`orgs/${orgId}/memory.sqlite`, async (localPath) => {
    const store = openScopeStore(localPath, {
      provider: getEmbeddingProvider(),
      create: false,
      readonly: true,
    })
    try {
      return listMemoryEdges(store, { limit: 50 })
    } finally {
      store.close()
    }
  })
}

describe('edges extracted at ingest reach the org graph', () => {
  test('a committed document stores the relationships it came with', async () => {
    const orgId = freshOrg()
    await commit(orgId, [
      { source: 'Helios cutover', target: 'Marcy Wu', relation: 'owned by' },
      { source: 'Helios cutover', target: 'queue drain', relation: 'depends on' },
    ])

    const edges = await edgesOf(orgId)
    expect(edges.map((e) => `${e.source} ${e.relation} ${e.target}`).sort()).toEqual([
      'Helios cutover depends on queue drain',
      'Helios cutover owned by Marcy Wu',
    ])
  })

  test('an edge is attributed to the document it was extracted from', async () => {
    const orgId = freshOrg()
    await commit(orgId, [{ source: 'Helios cutover', target: 'Marcy Wu', relation: 'owned by' }])

    const [edge] = await edgesOf(orgId)
    expect(edge!.documentId).toBe(`doc-${orgId}`)
    expect(edge!.documentTitle).toBe('Helios migration plan')
  })

  test('a document that yielded no relationships still commits', async () => {
    const orgId = freshOrg()
    await commit(orgId, [])
    expect(await edgesOf(orgId)).toEqual([])
  })

  test('extraction being skipped entirely still commits', async () => {
    const orgId = freshOrg()
    await commit(orgId, undefined)
    expect(await edgesOf(orgId)).toEqual([])
  })

  test('the graph is queryable by entity', async () => {
    const orgId = freshOrg()
    await commit(orgId, [
      { source: 'Helios cutover', target: 'Marcy Wu', relation: 'owned by' },
      { source: 'Aurora rollout', target: 'Sam Ade', relation: 'owned by' },
    ])

    const matched = (await edgesOf(orgId)).filter((e) => e.source === 'Helios cutover')
    expect(matched).toHaveLength(1)
    expect(matched[0]!.target).toBe('Marcy Wu')
  })
})
