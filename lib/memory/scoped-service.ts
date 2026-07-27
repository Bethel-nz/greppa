import { getCheckpoint, NotFoundError } from '~/utils/checkpoint'
import { R2Storage } from '~/utils/r2'
import { generateAnswer } from './answer'
import { putAssetIfAbsent } from './assets'
import { embedInBatches, getEmbeddingProvider } from './embedding'
import { chunkText } from './scope-store/chunker'
import { decayConfigFromEnv } from './scope-store/decay'
import { hybridSearch, insertDocument, openScopeStore, type ChunkInput } from './scope-store/store'
import { getOrCreatePersonalScope, scopeObjectKey } from './scope'

export type ScopedSourceType = 'note' | 'chat' | 'document' | 'webpage' | 'agent_event'

export type AddScopedMemoryInput = {
  userId: string
  title: string
  text: string
  sourceType?: ScopedSourceType
  sourceUrl?: string
  image?: { bytes: Uint8Array; mime: string }
}

export type SearchScopedMemoryInput = { userId: string; query: string; limit?: number }
export type AskScopedMemoryInput = { userId: string; question: string; limit?: number }

/**
 * A retrieved chunk. `snippet` mirrors `text` so existing consumers
 * (lib/chat/tools.ts) keep working against the shape Memvid used to return.
 */
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

/**
 * Append a memory to the caller's personal scope.
 *
 * Embeddings and asset uploads happen BEFORE Checkpoint's per-scope lock is
 * taken, so the mutex is held only for local SQLite writes. That keeps write
 * latency off the network path and makes Checkpoint's conflict-rerun cheap: a
 * rerun replays local inserts without re-billing the embedding API.
 */
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
    const digest = await putAssetIfAbsent(R2Storage.fromEnv(), scopeId, input.image.bytes)
    const [vector] = await provider.embedImage([input.image])
    chunks.push({
      // Carry the title as chunk text so an image is still lexically findable.
      text: input.title,
      embedding: vector!,
      modality: input.text.trim() ? 'text_image' : 'image',
      assetSha256: digest,
      assetMime: input.image.mime,
    })
  }

  if (chunks.length === 0) throw new Error('[memory] refusing to store an empty memory')

  const documentId = await getCheckpoint().write(key, async (localPath, exists) => {
    const store = openScopeStore(localPath, { provider, create: !exists })
    try {
      return insertDocument(store, {
        title: input.title,
        text: input.text,
        sourceType,
        sourceUrl: input.sourceUrl,
        createdBy: input.userId,
        meta: { app: 'greppa', source_type: sourceType },
        chunks,
      })
    } finally {
      // Must close before Checkpoint seals and uploads the file.
      store.close()
    }
  })

  return { scopeId, documentId, status: 'indexed' as const }
}

export async function searchScopedMemory(
  input: SearchScopedMemoryInput,
): Promise<{ hits: ScopedHit[]; total_hits: number }> {
  const scopeId = await getOrCreatePersonalScope(input.userId)
  const key = scopeObjectKey(scopeId)
  const provider = getEmbeddingProvider()
  const [queryVector] = await provider.embed([input.query], 'query')

  try {
    const hits = await getCheckpoint().read(key, async (localPath) => {
      const store = openScopeStore(localPath, { provider, create: false, readonly: true })
      try {
        return hybridSearch(store, input.query, queryVector!, input.limit ?? 8, undefined, decayConfigFromEnv())
      } finally {
        store.close()
      }
    })
    return { hits: hits.map((h) => ({ ...h, snippet: h.text })), total_hits: hits.length }
  } catch (err) {
    // No memory written yet for this scope -> empty result, not an error.
    if (err instanceof NotFoundError) return { hits: [], total_hits: 0 }
    throw err
  }
}

export async function askScopedMemory(input: AskScopedMemoryInput) {
  const { hits } = await searchScopedMemory({
    userId: input.userId,
    query: input.question,
    limit: input.limit ?? 10,
  })
  if (hits.length === 0) return { answer: null, sources: [], context: '', grounding: null }

  const context = hits.map((h, i) => `### [${i + 1}] ${h.title}\n${h.text}`).join('\n\n')
  const answer = await generateAnswer({ question: input.question, context })
  return { answer, sources: hits, context, grounding: null }
}
