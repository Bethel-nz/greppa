import { getCheckpoint, NotFoundError } from '~/utils/checkpoint'
import { getStorage } from '~/lib/storage'
import { putAssetIfAbsent } from './assets'
import { embedInBatches, getEmbeddingProvider } from './embedding'
import { formatPassages } from './context'
import { chunkText } from './scope-store/chunker'
import { decayConfigFromEnv } from './scope-store/decay'
import { RRF_K } from './scope-store/fusion'
import { embedEdgeNodes, searchMemory } from './service'
import {
  hybridSearch,
  deleteDocuments,
  documentExists,
  insertDocument,
  listFacts,
  listMemoryEdges,
  moveToPlacement,
  openScopeStore,
  resolveEntities,
  type ChunkInput,
  type MemoryEdge,
  type MemoryEdgeInput,
  type MemoryScope,
  type ResolvedEntities,
  type StoredFact,
} from './scope-store/store'
import { getOrCreatePersonalScope, scopeObjectKey } from './scope'

export type ScopedSourceType = 'note' | 'chat' | 'fact' | 'document' | 'webpage' | 'agent_event'

export type AddScopedMemoryInput = {
  userId: string
  id?: string
  title: string
  text: string
  sourceType?: ScopedSourceType
  sourceUrl?: string
  folderId?: string | null
  workspaceId?: string | null
  edges?: MemoryEdgeInput[]
  image?: { bytes: Uint8Array; mime: string }
}

export type SearchScopedMemoryInput = {
  userId: string
  query: string
  limit?: number
  folderId?: string | null
  workspaceId?: string | null
}
export type AskScopedMemoryInput = {
  userId: string
  question: string
  limit?: number
  folderId?: string | null
  workspaceId?: string | null
  orgId?: string
}
export type ListScopedMemoryEdgesInput = {
  userId: string
  entity?: string
  relation?: string
  limit?: number
  folderId?: string | null
  workspaceId?: string | null
}

function scopeOf(input: { workspaceId?: string | null; folderId?: string | null }): MemoryScope {
  return { workspaceId: input.workspaceId, folderId: input.folderId }
}

export type ScopedHit = {
  title: string
  snippet: string
  text: string
  score: number
  documentId: string
  chunkId: number
  sourceType: string
  sourceUrl: string | null
  modality: string
  assetSha256: string | null
}

export async function addScopedMemory(input: AddScopedMemoryInput) {
  const scopeId = await getOrCreatePersonalScope(input.userId)
  const key = scopeObjectKey(scopeId)
  const sourceType = input.sourceType ?? 'note'
  const provider = getEmbeddingProvider()

  const texts = chunkText(input.text)
  const vectors = texts.length ? await embedInBatches(provider, texts, 'document') : []
  const chunks: ChunkInput[] = texts.map((text, i) => ({
    text,
    embedding: vectors[i]!,
    modality: 'text',
  }))

  if (input.image) {
    if (!provider.embedImage) {
      throw new Error(`[memory] embedding provider ${provider.id} cannot embed images`)
    }
    const digest = await putAssetIfAbsent(getStorage(), scopeId, input.image.bytes)
    const [vector] = await provider.embedImage([input.image])
    chunks.push({
      text: input.title,
      embedding: vector!,
      modality: input.text.trim() ? 'text_image' : 'image',
      assetSha256: digest,
      assetMime: input.image.mime,
    })
  }

  if (chunks.length === 0) throw new Error('[memory] refusing to store an empty memory')

  const nodeVectors = await embedEdgeNodes(provider, input.edges)

  const written = await getCheckpoint().write(key, async (localPath, exists) => {
    const store = openScopeStore(localPath, { provider, create: !exists })
    try {
      const duplicate = input.id ? documentExists(store, input.id) : false
      const documentId = insertDocument(store, {
        id: input.id,
        title: input.title,
        text: input.text,
        sourceType,
        sourceUrl: input.sourceUrl,
        createdBy: input.userId,
        meta: { app: 'greppa', source_type: sourceType },
        workspaceId: input.workspaceId,
        folderId: input.folderId,
        edges: input.edges,
        nodeVectors,
        chunks,
      })
      return { documentId, duplicate }
    } finally {
      store.close()
    }
  })

  return {
    scopeId,
    documentId: written.documentId,
    status: written.duplicate ? ('duplicate' as const) : ('indexed' as const),
  }
}

async function readPersonalScope<T>(
  userId: string,
  read: (store: ReturnType<typeof openScopeStore>) => T,
  whenMissing: T,
): Promise<T> {
  const scopeId = await getOrCreatePersonalScope(userId)
  const provider = getEmbeddingProvider()

  try {
    return await getCheckpoint().read(scopeObjectKey(scopeId), async (localPath) => {
      const store = openScopeStore(localPath, { provider, create: false, readonly: true })
      try {
        return read(store)
      } finally {
        store.close()
      }
    })
  } catch (err) {
    if (err instanceof NotFoundError) return whenMissing
    throw err
  }
}

export async function searchScopedMemory(
  input: SearchScopedMemoryInput,
): Promise<{ hits: ScopedHit[]; total_hits: number; edges: MemoryEdge[] }> {
  const [queryVector] = await getEmbeddingProvider().embed([input.query], 'query')
  const scope = scopeOf(input)

  const { hits, edges } = await readPersonalScope(
    input.userId,
    (store) => {
      const hits = hybridSearch(
        store,
        input.query,
        queryVector!,
        input.limit ?? 8,
        undefined,
        decayConfigFromEnv(),
        scope,
      )
      return {
        hits,
        edges: listMemoryEdges(store, {
          documentIds: [...new Set(hits.map((hit) => hit.documentId))],
          scope,
          limit: 12,
        }),
      }
    },
    { hits: [], edges: [] },
  )

  return {
    hits: hits.map((h) => ({ ...h, snippet: h.text })),
    total_hits: hits.length,
    edges,
  }
}

export async function listScopedMemoryEdges(input: ListScopedMemoryEdgesInput): Promise<MemoryEdge[]> {
  return readPersonalScope(
    input.userId,
    (store) => listMemoryEdges(store, {
      entity: input.entity,
      relation: input.relation,
      limit: input.limit,
      scope: scopeOf(input),
    }),
    [],
  )
}

export async function resolveScopedEntities(input: {
  userId: string
  text: string
  limit?: number
}): Promise<ResolvedEntities> {
  const provider = getEmbeddingProvider()
  // Embedded once here so the synchronous store read can run the semantic tier.
  const [queryVector] = input.text.trim()
    ? await embedInBatches(provider, [input.text], 'query')
    : [undefined]
  return readPersonalScope(
    input.userId,
    (store) => resolveEntities(store, input.text, input.limit, queryVector),
    { matched: [], suggested: [] },
  )
}

export type MoveScopedMemoryInput = {
  userId: string
  documentIds: string[]
  workspaceId?: string | null
  folderId?: string | null
}

/**
 * Mutate a scope that already exists, without creating one that does not.
 * `checkpoint.write` expects its callback to leave a file behind, so a mutation
 * that would no-op on a missing scope has to be skipped before it starts.
 */
async function writeExistingScope<T>(
  userId: string,
  mutate: (store: ReturnType<typeof openScopeStore>) => T,
  whenMissing: T,
): Promise<T> {
  const scopeId = await getOrCreatePersonalScope(userId)
  const key = scopeObjectKey(scopeId)
  const checkpoint = getCheckpoint()
  if (!(await checkpoint.stat(key))) return whenMissing

  const provider = getEmbeddingProvider()
  return checkpoint.write(key, async (localPath, exists) => {
    if (!exists) return whenMissing
    const store = openScopeStore(localPath, { provider, create: false })
    try {
      return mutate(store)
    } finally {
      store.close()
    }
  })
}

export async function moveScopedMemory(input: MoveScopedMemoryInput): Promise<{ moved: number }> {
  if (input.documentIds.length === 0) return { moved: 0 }
  const moved = await writeExistingScope(
    input.userId,
    (store) => moveToPlacement(store, input.documentIds, scopeOf(input)),
    0,
  )
  return { moved }
}

export async function deleteScopedMemory(input: {
  userId: string
  documentIds: string[]
}): Promise<{ deleted: number }> {
  if (input.documentIds.length === 0) return { deleted: 0 }
  const deleted = await writeExistingScope(
    input.userId,
    (store) => deleteDocuments(store, input.documentIds),
    0,
  )
  return { deleted }
}

export async function listScopedFacts(input: {
  userId: string
  limit?: number
  workspaceId?: string | null
  folderId?: string | null
}): Promise<StoredFact[]> {
  return readPersonalScope(
    input.userId,
    (store) => listFacts(store, {
      sourceType: 'fact',
      limit: input.limit ?? 40,
      scope: scopeOf(input),
    }),
    [],
  )
}

export function fuseAcrossScopes(lists: ScopedHit[][], limit: number): ScopedHit[] {
  const scores = new Map<string, number>()
  const byKey = new Map<string, ScopedHit>()

  for (let listIndex = 0; listIndex < lists.length; listIndex++) {
    const list = lists[listIndex]!
    for (let rank = 0; rank < list.length; rank++) {
      const hit = list[rank]!
      const key = `${listIndex}:${hit.documentId}:${hit.chunkId}`
      scores.set(key, (scores.get(key) ?? 0) + 1 / (RRF_K + rank + 1))
      if (!byKey.has(key)) byKey.set(key, hit)
    }
  }

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, score]) => ({ ...byKey.get(key)!, score }))
}

export async function retrieveScopedContext(input: AskScopedMemoryInput) {
  const limit = input.limit ?? 10
  const personal = await searchScopedMemory({
    userId: input.userId,
    query: input.question,
    limit,
    workspaceId: input.workspaceId,
    folderId: input.folderId,
  })

  let orgHits: ScopedHit[] = []
  if (input.orgId && !input.workspaceId) {
    try {
      const org = await searchMemory({
        userId: input.userId,
        orgId: input.orgId,
        query: input.question,
        limit,
      })
      orgHits = org.hits as ScopedHit[]
    } catch (err) {
      console.warn('[memory] org scope search failed, continuing with personal only', err)
    }
  }

  const edges = personal.edges
  const hits = orgHits.length ? fuseAcrossScopes([personal.hits, orgHits], limit) : personal.hits
  if (hits.length === 0) return { sources: [], context: '', edges: [] }

  const graphContext = edges.length
    ? `## Relationships backed by these memories\n${edges.map((edge) => `- ${edge.source} ${edge.relation} ${edge.target}`).join('\n')}`
    : ''
  return {
    sources: hits,
    context: [formatPassages(hits), graphContext].filter(Boolean).join('\n\n'),
    edges,
  }
}
